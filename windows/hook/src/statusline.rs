//! `coucou-hook --statusline`: Claude Code's status line command.
//!
//! Claude Code runs it after each reply with the session's JSON on stdin. For
//! Pro and Max plans that JSON carries `rate_limits` (the 5-hour and weekly
//! windows). We hand only those, with the session id, to Coucou for the plan
//! gauge, then print the status line itself:
//!
//! * if the user had a status line before Coucou's, Coucou saved it as
//!   `statusline-previous.json` beside this relay, and we run it with the same
//!   stdin and print what it prints, so it keeps working as before;
//! * otherwise we print the plan usage, short (`5h 23% · week 41%`).
//!
//! Same rule as the hooks: never hold Claude Code up. Coucou closed costs
//! nothing, the relay gets the usual fire-and-forget budget, and a previous
//! command that hangs is stopped after ten seconds with nothing printed.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Name of the saved status line, beside the relay. Coucou writes it.
pub const PREVIOUS_FILE: &str = "statusline-previous.json";
/// How long the user's own status line may take, as on macOS.
const PREVIOUS_BUDGET: Duration = Duration::from_secs(10);

pub fn run() {
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    let input = parse(&raw);

    let line = relay_line(&input);
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let _ = crate::talk(&line, false);
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(crate::FIRE_AND_FORGET_BUDGET);

    let out = match previous_command() {
        Some(command) => run_previous(&command, &raw),
        None => plan_line(&input).into_bytes(),
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(&out);
    let _ = stdout.flush();
}

/// Claude Code's JSON, or an empty object when there is none to read.
fn parse(raw: &[u8]) -> Value {
    let text = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    serde_json::from_slice::<Value>(text).ok().filter(Value::is_object).unwrap_or_else(|| json!({}))
}

/// What Coucou gets: the plan windows and the session they came from, nothing
/// else from the status line data (no paths, no costs, no transcript).
fn relay_line(input: &Value) -> String {
    let relay = json!({
        "coucou_kind": "statusline",
        "session_id": input.get("session_id").cloned().unwrap_or(Value::Null),
        "rate_limits": input.get("rate_limits").cloned().unwrap_or_else(|| json!({})),
    });
    format!("{relay}\n")
}

/// `5h 23% · week 41%`, or nothing when Claude Code sent no plan windows.
fn plan_line(input: &Value) -> String {
    let limits = input.get("rate_limits");
    let pct = |window: &str| {
        limits?
            .get(window)?
            .get("used_percentage")?
            .as_f64()
            .filter(|p| p.is_finite() && *p >= 0.0)
            .map(|p| format!("{}%", p.min(100.0).round() as u32))
    };
    let parts: Vec<String> = [("5h", pct("five_hour")), ("week", pct("seven_day"))]
        .into_iter()
        .filter_map(|(label, value)| value.map(|v| format!("{label} {v}")))
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("{}\n", parts.join(" · "))
    }
}

/// The status line the user had before Coucou's, if Coucou saved one.
fn previous_command() -> Option<String> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    previous_command_in(&dir)
}

fn previous_command_in(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join(PREVIOUS_FILE)).ok()?;
    let saved = parse(&bytes);
    let command = saved.get("command")?.as_str()?.trim();
    // Never ourselves: that would only ever call itself again.
    (!command.is_empty() && !command.contains("--statusline")).then(|| command.to_string())
}

/// Runs the saved status line the way Claude Code would, with the same stdin,
/// and returns its stdout. A failure or a timeout prints nothing.
fn run_previous(command: &str, stdin: &[u8]) -> Vec<u8> {
    let Ok(mut child) = shell(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    if let Some(mut input) = child.stdin.take() {
        let data = stdin.to_vec();
        std::thread::spawn(move || {
            let _ = input.write_all(&data);
        });
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut output) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = output.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let deadline = Instant::now() + PREVIOUS_BUDGET;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
        }
    }
    rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default()
}

/// Claude Code runs status lines through Git Bash when it is installed and
/// through PowerShell otherwise; the saved command gets the same treatment.
#[cfg(windows)]
fn shell(command: &str) -> Command {
    match git_bash() {
        Some(bash) => {
            let mut cmd = Command::new(bash);
            cmd.args(["-c", command]);
            cmd
        }
        None => {
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", command]);
            cmd
        }
    }
}

#[cfg(unix)]
fn shell(command: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", command]);
    cmd
}

/// Git for Windows' bash.exe — never WSL's `bash.exe` in System32 or
/// WindowsApps, which runs Linux, not the user's Windows tools.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    if let Some(path) = env("CLAUDE_CODE_GIT_BASH_PATH").filter(|p| p.is_file()) {
        return Some(path);
    }
    let on_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).map(|dir| dir.join("git.exe")).collect::<Vec<_>>())
        .unwrap_or_default();
    let installs = ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|name| env(name))
        .chain(env("LOCALAPPDATA").map(|dir| dir.join("Programs")))
        .map(|dir| dir.join("Git").join("cmd").join("git.exe"))
        .collect::<Vec<_>>();
    on_path.iter().chain(installs.iter()).find_map(|git| bash_beside(git))
}

/// `<Git>\bin\bash.exe` for a git.exe in `<Git>\cmd`, `<Git>\bin` or
/// `<Git>\mingw64\bin`.
#[cfg_attr(not(windows), allow(dead_code))]
fn bash_beside(git: &Path) -> Option<PathBuf> {
    if !git.is_file() {
        return None;
    }
    git.ancestors()
        .skip(1)
        .take(3)
        .map(|root| root.join("bin").join("bash.exe"))
        .find(|bash| bash.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-statusline-{name}-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_plan_windows_and_session_reach_coucou() {
        let input = json!({
            "session_id": "s1",
            "cwd": "C:/secret/project",
            "cost": { "total_cost_usd": 1.5 },
            "transcript_path": "C:/t.jsonl",
            "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 } },
        });
        let line = relay_line(&input);
        assert!(line.ends_with('\n'));
        let sent: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(sent, json!({
            "coucou_kind": "statusline",
            "session_id": "s1",
            "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 } },
        }));
        // Nothing to read still tells Coucou the relay is alive.
        let empty: Value = serde_json::from_str(relay_line(&parse(b"")).trim()).unwrap();
        assert_eq!(empty["rate_limits"], json!({}));
        assert_eq!(parse(b"\xEF\xBB\xBF{\"session_id\":\"x\"}")["session_id"], "x");
        assert_eq!(parse(b"[1,2]"), json!({}));
    }

    #[test]
    fn the_plan_line_is_short_and_skips_what_is_missing() {
        let both = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 23.5, "resets_at": 1 },
            "seven_day": { "used_percentage": 140, "resets_at": 2 },
        }});
        assert_eq!(plan_line(&both), "5h 24% · week 100%\n");
        let week = json!({ "rate_limits": { "seven_day": { "used_percentage": 41.2 } } });
        assert_eq!(plan_line(&week), "week 41%\n");
        assert_eq!(plan_line(&json!({})), "");
        assert_eq!(plan_line(&json!({ "rate_limits": { "five_hour": { "used_percentage": -3 } } })), "");
    }

    #[test]
    fn a_saved_status_line_is_found_but_never_ourselves() {
        let dir = temp_dir("previous");
        assert_eq!(previous_command_in(&dir), None);
        std::fs::write(dir.join(PREVIOUS_FILE), r#"{"type":"command","command":"~/.claude/statusline.sh","padding":2}"#).unwrap();
        assert_eq!(previous_command_in(&dir).as_deref(), Some("~/.claude/statusline.sh"));
        std::fs::write(dir.join(PREVIOUS_FILE), r#"{"type":"command","command":"\"C:/x/coucou-hook.exe\" --statusline"}"#).unwrap();
        assert_eq!(previous_command_in(&dir), None);
        std::fs::write(dir.join(PREVIOUS_FILE), "not json").unwrap();
        assert_eq!(previous_command_in(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_bash_is_looked_for_beside_git_only() {
        let root = temp_dir("git");
        for dir in ["cmd", "bin", "mingw64/bin"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(root.join("cmd").join("git.exe"), b"").unwrap();
        std::fs::write(root.join("mingw64").join("bin").join("git.exe"), b"").unwrap();
        assert_eq!(bash_beside(&root.join("cmd").join("git.exe")), None);
        std::fs::write(root.join("bin").join("bash.exe"), b"").unwrap();
        let bash = root.join("bin").join("bash.exe");
        assert_eq!(bash_beside(&root.join("cmd").join("git.exe")), Some(bash.clone()));
        assert_eq!(bash_beside(&root.join("mingw64").join("bin").join("git.exe")), Some(bash));
        assert_eq!(bash_beside(&root.join("missing").join("git.exe")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_previous_status_line_gets_the_same_stdin_and_its_output_is_kept() {
        // findstr echoes every line under Git Bash and PowerShell alike.
        #[cfg(windows)]
        let command = "findstr \"^\"";
        #[cfg(unix)]
        let command = "cat";
        let out = String::from_utf8(run_previous(command, b"{\"a\":1}\n")).unwrap();
        assert_eq!(out.trim(), "{\"a\":1}");
        assert!(run_previous("exit 3", b"").is_empty());
    }
}
