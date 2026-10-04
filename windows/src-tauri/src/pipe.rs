// Relay server for coucou-hook.
//
// Windows: the named pipe `\\.\pipe\coucou-<sid>`, one instance per connection.
// Linux: the Unix socket `$XDG_RUNTIME_DIR/coucou.sock`. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same connection, which is how approving from the island works.
//
// A Codex session whose approvals go to Codex's own reviewer (auto-review)
// never asks a person, so its requests are not put on the island at all: the
// connection closes at once and Codex carries on as if Coucou were not there.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * coucou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// The agent can also stop waiting first (its own timeout, an interrupted turn):
// it ends the relay, the pipe closes, and the island is told to take its card
// down rather than offer a click that can no longer reach anyone.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is coucou-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::future::Future;
use std::pin::pin;
use std::task::Poll;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;

/// Slightly under coucou-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// When each agent last reached us, for the delivery line in Settings.
static LAST_EVENT: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn note_event(payload: &Value) {
    // Payloads without a tag come from Claude Code, as everywhere else.
    let agent = payload.get("coucou_agent").and_then(Value::as_str).unwrap_or("claude");
    if agent.len() > 24 {
        return;
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    LAST_EVENT.get_or_init(Default::default).lock().unwrap().insert(agent.to_string(), now);
}

/// Unix seconds of the last event from `agent` since Coucou started.
pub fn last_event(agent: &str) -> Option<u64> {
    LAST_EVENT.get()?.lock().unwrap().get(agent).copied()
}

/// `\\.\pipe\coucou-<sid>` — must match coucou-hook's `pipe_path()` exactly.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let key = crate::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    tauri::async_runtime::spawn(async move {
        let Some(path) = crate::platform::relay_socket_path() else {
            log::line("no private runtime directory ($XDG_RUNTIME_DIR) — Claude Code hooks are inactive");
            return;
        };
        // A socket file left behind by a crash answers nothing and can go. One
        // that answers belongs to a Coucou that is still running: like
        // first_pipe_instance on Windows, we refuse to serve on top of it.
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                log::line("another Coucou already serves the relay socket");
                return;
            }
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("cannot open the relay socket: {err}"));
                return;
            }
        };
        // The runtime directory is already 0700; this is belt and braces.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let uid = unsafe { libc::getuid() };
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            // Only the relay run by our own user may drive the island.
            if !matches!(stream.peer_cred(), Ok(c) if c.uid() == uid) {
                log::line("refused a relay connection from another user");
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, stream).await });
        }
    });
}

/// One accepted relay connection, whatever carries it.
trait Relay: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
}

#[cfg(windows)]
impl Relay for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
}

/// Dropping the stream closes it; the relay reads up to our newline first.
#[cfg(target_os = "linux")]
impl Relay for tokio::net::UnixStream {}

async fn handle(app: AppHandle, mut pipe: impl Relay) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }
    note_event(&payload);

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if event != "PermissionRequest" {
    log::line(format!("hook {event}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
    pipe.finish();
    return;
}

    if left_to_codex_review(&payload).await {
        log::line("hook PermissionRequest left to Codex auto-review");
        pipe.finish();
        return;
    }
    // Only needed for that check; the island never sees transcript paths.
    if let Some(map) = payload.as_object_mut() {
        map.remove("transcript_path");
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook PermissionRequest id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    // Whichever comes first: the island's answer, or the relay hanging up.
    let answered = {
        let mut decided = pin!(wait_for_decision(&id, &mut rx));
        let mut gone = pin!(hung_up(&mut pipe));
        std::future::poll_fn(|cx| {
            if let Poll::Ready(decision) = decided.as_mut().poll(cx) {
                return Poll::Ready(Some(decision));
            }
            if gone.as_mut().poll(cx).is_ready() {
                return Poll::Ready(None);
            }
            Poll::Pending
        })
        .await
    };
    let decision = answered.unwrap_or_else(|| {
        log::line(format!("hook id={id} relay hung up — the agent stopped waiting"));
        let _ = app.emit_to(WINDOW_LABEL, "approval-gone", json!({ "requestId": id }));
        None
    });
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. coucou-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Coucou were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    pipe.finish();
}

/// A Codex request that Codex's reviewer agent will settle without a person.
/// Reading the transcript is blocking file work, so it runs off the runtime.
async fn left_to_codex_review(payload: &Value) -> bool {
    if payload.get("coucou_agent").and_then(Value::as_str) != Some("codex") {
        return false;
    }
    let payload = payload.clone();
    tokio::task::spawn_blocking(move || crate::codex_review::auto_reviewed(&payload))
        .await
        .unwrap_or(false)
}

/// Resolves once the relay closes its end of the connection. It sends nothing
/// after its one line, so any read that returns is either the close or noise.
async fn hung_up(pipe: &mut (impl AsyncRead + Unpin)) {
    let mut byte = [0u8; 1];
    loop {
        match pipe.read(&mut byte).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is coucou-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_that_hangs_up_is_noticed_and_a_waiting_one_is_not() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let (mut server, client) = tokio::io::duplex(64);
            // Still connected and silent, like a relay waiting for the decision.
            assert!(tokio::time::timeout(Duration::from_millis(50), hung_up(&mut server)).await.is_err());
            drop(client);
            assert!(tokio::time::timeout(Duration::from_secs(1), hung_up(&mut server)).await.is_ok());
        });
    }
}
