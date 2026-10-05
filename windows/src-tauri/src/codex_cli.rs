// Codex's Mochi on the user's ChatGPT plan. Instead of calling the API with a
// key, Coucou runs the official Codex CLI the user is signed in to:
// `codex exec`, read-only, ephemeral (nothing added to the Codex session
// history) and with hooks disabled for that run, so the chat never shows up as
// Codex activity in the island. Coucou never reads or stores the sign-in.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::claude::{self, Chat, ChatContext, ChatError, ChatReply};
use crate::{platform, settings};

/// Long enough for web search plus reasoning, short enough to give the chat back.
const TIMEOUT: Duration = Duration::from_secs(240);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(20);

static RUNS: AtomicU64 = AtomicU64::new(1);

fn codex() -> Result<PathBuf, ChatError> {
    platform::find_on_path("codex").ok_or_else(|| ChatError::new(
        "cli_missing",
        "Codex's Mochi uses your Codex sign-in, but the Codex CLI was not found. Install it, or switch Codex's Mochi to an OpenAI API key in Settings.",
        true,
    ))
}

fn work_dir() -> Result<PathBuf, ChatError> {
    let dir = settings::local_dir().join("mochi").join("codex");
    std::fs::create_dir_all(&dir).map_err(|_| ChatError::new(
        "cli",
        "Could not prepare Codex's Mochi folder. Check that Coucou can write to its data folder.",
        false,
    ))?;
    Ok(dir)
}

/// One turn's arguments. The prompt arrives on stdin (`-`), so nothing the user
/// typed ever reaches a command line. Images come first: `-i` takes several
/// values, and the next flag ends the list.
fn exec_args(dir: &Path, reply: &Path, images: &[PathBuf]) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["exec".into()];
    for image in images {
        args.push("-i".into());
        args.push(image.into());
    }
    for arg in [
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--color", "never",
        "--disable", "hooks",
        "-c", "web_search=live",
        "-c", "model_reasoning_effort=low",
    ] {
        args.push(arg.into());
    }
    args.push("-C".into());
    args.push(dir.into());
    args.push("-o".into());
    args.push(reply.into());
    args.push("-".into());
    args
}

/// Codex keeps no session for these chats, so each turn carries the
/// conversation so far.
fn prompt(history: &[Value], turn: &str) -> String {
    let mut text = String::from(claude::SYSTEM_PROMPT);
    text.push_str(
        "\nYou are answering in a small chat bubble on the user's screen, not working in a project: \
do not run commands or look at files unless the user asks about a file they attached.\n",
    );
    if !history.is_empty() {
        text.push_str("\nConversation so far:\n");
        for message in history {
            let who = if message["role"] == "assistant" { "Mochi" } else { "User" };
            text.push_str(&format!("\n{who}: {}\n", message["content"].as_str().unwrap_or("")));
        }
    }
    text.push_str("\nThe user's new message:\n");
    text.push_str(turn);
    text.push('\n');
    text
}

pub(crate) enum FileInput {
    Image,
    Text(String),
    Reference,
}

pub(crate) fn file_input(path: &str) -> FileInput {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return FileInput::Image;
    }
    if ext != "pdf" {
        let small = std::fs::metadata(path).map(|m| m.len() <= claude::MAX_INLINE_TEXT).unwrap_or(false);
        if let (true, Ok(text)) = (small, std::fs::read_to_string(path)) {
            return FileInput::Text(text);
        }
    }
    // PDFs and anything else: Codex may read it itself in its read-only sandbox.
    FileInput::Reference
}

/// One chat turn with Codex's Mochi through `codex exec`.
pub async fn send(chat: &Chat, query: String, context: Option<ChatContext>) -> Result<ChatReply, ChatError> {
    let codex = codex()?;
    let dir = work_dir()?;

    let mut turn = String::new();
    let mut images: Vec<String> = Vec::new();
    // Context rides along with the first message only, as with the APIs.
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                match file_input(path) {
                    FileInput::Image => images.push(path.clone()),
                    FileInput::Text(text) => turn.push_str(&format!("File contents:\n{text}\n\n")),
                    FileInput::Reference => turn.push_str(&format!("The user attached the file at {path}.\n")),
                }
                turn.push_str(&format!("File: {name}\n\n"));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                turn.push_str(&text);
                turn.push_str("\n\n");
            }
            None => {}
        }
    }
    turn.push_str(&query);

    let (generation, history) = chat.begin(json!({ "role": "user", "content": turn.clone(), "images": images }));
    // Images attached earlier in the conversation stay visible to later turns.
    let all_images: Vec<PathBuf> = history
        .iter()
        .flat_map(|m| m["images"].as_array().cloned().unwrap_or_default())
        .filter_map(|p| p.as_str().map(PathBuf::from))
        .filter(|p| p.is_file())
        .collect();
    let text = prompt(&history[..history.len() - 1], &turn);
    let reply = dir.join(format!("reply-{}-{}.txt", std::process::id(), RUNS.fetch_add(1, Ordering::Relaxed)));

    let result = tauri::async_runtime::spawn_blocking(move || run(&codex, &dir, &reply, &text, &all_images))
        .await
        .unwrap_or_else(|_| Err(ChatError::new("cli", "Codex stopped unexpectedly. Try again.", false)));
    match result {
        Ok(text) => {
            chat.finish(generation, Some(json!({ "role": "assistant", "content": text })));
            Ok(ChatReply { text })
        }
        Err(err) => {
            chat.finish(generation, None);
            Err(err)
        }
    }
}

fn run(codex: &Path, dir: &Path, reply: &Path, prompt: &str, images: &[PathBuf]) -> Result<String, ChatError> {
    let mut cmd = Command::new(codex);
    cmd.current_dir(dir)
        .args(exec_args(dir, reply, images))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| ChatError::new(
        "cli",
        "Could not start the Codex CLI. Check that `codex` runs in a terminal.",
        false,
    ))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    } // dropped here: Codex sees the end of the prompt
    let log = drain(&mut child);
    let status = wait(&mut child, TIMEOUT);
    let log = log.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let text = std::fs::read_to_string(reply).unwrap_or_default();
    let _ = std::fs::remove_file(reply);
    match status {
        None => Err(ChatError::new("timeout", "Codex did not answer within 4 minutes. Try again.", false)),
        Some(true) if !text.trim().is_empty() => Ok(text.trim().to_string()),
        Some(true) => Err(ChatError::new("response", "Codex returned no text. Try again.", false)),
        Some(false) => Err(classify(&log)),
    }
}

/// Reads stderr on its own thread so a chatty Codex can never fill the pipe.
fn drain(child: &mut Child) -> std::sync::mpsc::Receiver<String> {
    read_all(child.stderr.take())
}

pub(crate) fn read_all(stream: Option<impl Read + Send + 'static>) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_end(&mut bytes);
        }
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    rx
}

/// `codex login status` says "Logged in using ChatGPT" (or an API key).
fn signed_in(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("logged in") && !lower.contains("not logged in")
}

/// `Some(success)` once the process ends, `None` after killing it on timeout.
pub(crate) fn wait(child: &mut Child, timeout: Duration) -> Option<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(150)),
            _ => {
                kill_tree(child);
                return None;
            }
        }
    }
}

/// `codex` is an npm shim (cmd → node → codex.exe), and Claude Code may start
/// helpers of its own: end the whole tree.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        platform::no_console(&mut taskkill);
        let _ = taskkill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Turns Codex's stderr into an actionable message without echoing it.
fn classify(log: &str) -> ChatError {
    let lower = log.to_lowercase();
    if lower.contains("usage limit") || lower.contains("purchase more credits") {
        let message = match retry_time(log) {
            Some(time) => format!("Your ChatGPT plan's Codex usage limit was reached. Codex says you can try again at {time}."),
            None => "Your ChatGPT plan's Codex usage limit was reached. Try again later.".into(),
        };
        return ChatError::new("usage_limit", message, false);
    }
    if lower.contains("not logged in") || lower.contains("codex login") || lower.contains("unauthorized") || lower.contains("sign in again") {
        return ChatError::new(
            "missing_login",
            "Codex isn't signed in. Run `codex login` in a terminal and sign in with ChatGPT, then try again.",
            true,
        );
    }
    if lower.contains("rate limit") || lower.contains("too many requests") {
        return ChatError::new("rate_limit", "Codex reported a rate limit. Wait a moment and try again.", false);
    }
    if lower.contains("stream disconnected") || lower.contains("error sending request") || lower.contains("connection") {
        return ChatError::new("network", "Codex could not reach OpenAI. Check your connection, proxy, or firewall and try again.", false);
    }
    ChatError::new("cli", "Codex could not answer. Check that `codex exec` works in a terminal, then try again.", false)
}

/// "try again at 9:31 PM" → "9:31 PM": only digits, letters, spaces and colons.
fn retry_time(log: &str) -> Option<String> {
    let lower = log.to_lowercase();
    let start = lower.find("try again at ")? + "try again at ".len();
    let time: String = log[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == ':' || *c == ' ')
        .take(16)
        .collect();
    let time = time.trim().to_string();
    (!time.is_empty() && time.chars().any(|c| c.is_ascii_digit())).then_some(time)
}

/// Checks that Codex is signed in, without sending a message.
pub async fn test_connection() -> Result<(), ChatError> {
    let codex = codex()?;
    tauri::async_runtime::spawn_blocking(move || login_status(&codex))
        .await
        .unwrap_or_else(|_| Err(ChatError::new("cli", "Codex stopped unexpectedly. Try again.", false)))
}

fn login_status(codex: &Path) -> Result<(), ChatError> {
    let mut cmd = Command::new(codex);
    // Codex prints its login status on stderr, so read both streams.
    cmd.args(["login", "status"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| ChatError::new(
        "cli",
        "Could not start the Codex CLI. Check that `codex` runs in a terminal.",
        false,
    ))?;
    let stdout = read_all(child.stdout.take());
    let stderr = drain(&mut child);
    let ok = wait(&mut child, LOGIN_TIMEOUT);
    let text = format!(
        "{}\n{}",
        stdout.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        stderr.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
    );
    if ok == Some(true) && signed_in(&text) {
        Ok(())
    } else {
        Err(classify("not logged in"))
    }
}

/// How long Codex gets to answer a usage read; it normally takes about a second.
const USAGE_TIMEOUT: Duration = Duration::from_secs(20);

/// The JSON lines that ask `codex app-server` for the account's usage: the
/// handshake, then `account/rateLimits/read`.
pub(crate) fn usage_requests() -> String {
    [
        json!({ "method": "initialize", "id": 1, "params": { "clientInfo": {
            "name": "coucou", "title": "Coucou", "version": env!("CARGO_PKG_VERSION") } } }),
        json!({ "method": "initialized" }),
        json!({ "method": "account/rateLimits/read", "id": 2 }),
    ]
    .iter()
    .map(|line| format!("{line}\n"))
    .collect()
}

/// The `rateLimits` of the usage read's answer, among everything the server said.
pub(crate) fn usage_answer(output: &str) -> Option<Value> {
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|message| message["id"] == 2)
        .and_then(|answer| answer.get("result")?.get("rateLimits").cloned())
}

/// Codex's plan usage as the Codex app shows it, from Codex itself:
/// `codex app-server` answering `account/rateLimits/read`. No model call is
/// made and nothing counts against the plan; Coucou never sees the sign-in.
pub(crate) fn rate_limits() -> Option<Value> {
    let codex = codex().ok()?;
    let mut cmd = Command::new(codex);
    cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(usage_requests().as_bytes());
        let _ = stdin.flush();
        // Kept open until the answer is in: the server stops when stdin closes.
        let deadline = Instant::now() + USAGE_TIMEOUT;
        let answer = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(line) => {
                    if let Some(limits) = usage_answer(&line) {
                        break Some(limits);
                    }
                    if serde_json::from_str::<Value>(&line).is_ok_and(|m| m["id"] == 2) {
                        break None;
                    }
                }
                Err(_) => break None,
            }
        };
        drop(stdin);
        kill_tree(&mut child);
        return answer;
    }
    kill_tree(&mut child);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_usage_read_is_the_documented_handshake_and_its_answer_is_found() {
        let lines: Vec<Value> = usage_requests().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["method"], "initialize");
        assert_eq!(lines[0]["params"]["clientInfo"]["name"], "coucou");
        assert_eq!(lines[1], json!({ "method": "initialized" }));
        assert_eq!(lines[2], json!({ "method": "account/rateLimits/read", "id": 2 }));
        let output = concat!(
            r#"{"id":1,"result":{"userAgent":"coucou"}}"#, "\n",
            r#"{"method":"account/rateLimits/updated","params":{}}"#, "\n",
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":13,"windowDurationMins":300,"resetsAt":1791227895}}}}"#, "\n",
        );
        assert_eq!(usage_answer(output).unwrap()["primary"]["usedPercent"], 13);
        assert_eq!(usage_answer(r#"{"id":2,"error":{"message":"not signed in"}}"#), None);
    }

    #[test]
    #[ignore = "Starts `codex app-server` and reads the signed-in account's usage (no model call)"]
    fn native_codex_usage_is_read() {
        let limits = rate_limits().expect("Codex answered");
        assert!(limits.get("primary").is_some() || limits.get("secondary").is_some(), "{limits}");
    }

    #[test]
    fn the_prompt_never_reaches_the_command_line() {
        let args = exec_args(Path::new("C:/mochi"), Path::new("C:/mochi/reply.txt"), &[PathBuf::from("C:/shot.png")]);
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert_eq!(&args[1..3], ["-i", "C:/shot.png"]);
        assert_eq!(args.last().map(String::as_str), Some("-"));
        for expected in ["--ephemeral", "read-only", "hooks", "web_search=live", "--skip-git-repo-check"] {
            assert!(args.iter().any(|a| a == expected), "{expected}");
        }
        assert!(args.windows(2).any(|w| w[0] == "--disable" && w[1] == "hooks"));
        assert!(args.windows(2).any(|w| w[0] == "--sandbox" && w[1] == "read-only"));
        assert!(!args.iter().any(|a| a.contains("danger") || a.contains("bypass")));
    }

    #[test]
    fn each_turn_carries_the_conversation() {
        let history = vec![
            json!({ "role": "user", "content": "first question" }),
            json!({ "role": "assistant", "content": "first answer" }),
        ];
        let text = prompt(&history, "second question");
        assert!(text.starts_with(claude::SYSTEM_PROMPT));
        let first = text.find("User: first question").unwrap();
        let answer = text.find("Mochi: first answer").unwrap();
        let second = text.find("second question").unwrap();
        assert!(first < answer && answer < second);
        assert!(!prompt(&[], "hello").contains("Conversation so far"));
    }

    #[test]
    fn errors_are_actionable_and_do_not_echo_codex_output() {
        let limit = classify("ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:31 PM.");
        assert_eq!(limit.code, "usage_limit");
        assert!(limit.message.ends_with("try again at 9:31 PM."));
        assert!(!limit.message.contains("https://"));
        assert_eq!(classify("Error: Not logged in. Run codex login").code, "missing_login");
        assert!(classify("Not logged in").settings);
        assert_eq!(classify("429 Too Many Requests").code, "rate_limit");
        assert_eq!(classify("stream disconnected before completion").code, "network");
        let unknown = classify("panic: secret-sentinel");
        assert_eq!(unknown.code, "cli");
        assert!(!unknown.message.contains("secret-sentinel"));
        assert!(signed_in("\nLogged in using ChatGPT\r\n"));
        assert!(signed_in("Logged in using an API key - sk-***"));
        assert!(!signed_in("Not logged in"));
        assert!(!signed_in(""));
        assert_eq!(retry_time("try again at <script>"), None);
        assert_eq!(retry_time("Try again at 21:31."), Some("21:31".into()));
    }

    #[test]
    fn dropped_files_become_images_text_or_a_reference() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-codex-cli-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().to_string()
        };
        assert!(matches!(file_input(&write("a.PNG", b"x")), FileInput::Image));
        assert!(matches!(file_input(&write("a.md", b"hello")), FileInput::Text(t) if t == "hello"));
        assert!(matches!(file_input(&write("a.pdf", b"%PDF")), FileInput::Reference));
        let large = vec![b'a'; claude::MAX_INLINE_TEXT as usize + 1];
        assert!(matches!(file_input(&write("big.txt", &large)), FileInput::Reference));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "Runs the installed Codex CLI's `codex login status`; sends no message"]
    fn native_codex_sign_in_is_detected() {
        let codex = codex().expect("the Codex CLI must be on PATH for this explicit test");
        login_status(&codex).expect("Codex should report a sign-in");
    }

    #[test]
    #[ignore = "Sends one short question through `codex exec`; uses the signed-in ChatGPT plan"]
    fn native_codex_exec_answers() {
        let codex = codex().expect("the Codex CLI must be on PATH for this explicit test");
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-codex-exec-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        let reply = dir.join("reply.txt");
        let text = prompt(&[], "Reply with exactly the word: pong");
        let answer = run(&codex, &dir, &reply, &text, &[]);
        let _ = std::fs::remove_dir_all(&dir);
        let answer = answer.map_err(|e| e.message).expect("Codex should answer");
        assert!(answer.to_lowercase().contains("pong"), "{answer}");
    }
}
