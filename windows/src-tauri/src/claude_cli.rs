// Claude's Mochi on the user's Claude plan. Instead of calling the API with a
// key, Coucou runs the official, unmodified Claude Code the user is signed in
// to: `claude -p` in restricted mode (no commands; file reads confined to the
// folders Coucou names), with hooks, plugins and MCP servers off and no session
// saved, so the chat never shows up as Claude Code activity in the island or in
// `claude --resume`. Coucou never reads or stores the sign-in.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

use crate::claude::{self, Chat, ChatContext, ChatError, ChatReply};
use crate::codex_cli::{file_input, read_all, wait, FileInput};
use crate::{launch, platform, settings};

/// Long enough for web search plus an answer, short enough to give the chat back.
const TIMEOUT: Duration = Duration::from_secs(240);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
/// Everything Mochi may do: read a file the user dropped, search and fetch the web.
const TOOLS: &str = "Read,WebSearch,WebFetch";
/// Settings that make sure no hook fires for Mochi's own runs.
const NO_HOOKS: &str = r#"{"disableAllHooks":true}"#;
/// Variables that would make Claude Code bill an API key instead of the plan,
/// or believe it runs inside another Claude Code session.
const CLEARED_ENV: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"];

fn claude_exe() -> Result<PathBuf, ChatError> {
    launch::find_claude().ok_or_else(|| ChatError::new(
        "cli_missing",
        "Claude's Mochi uses your Claude Code sign-in, but Claude Code was not found. Install it and sign in once by running `claude` in a terminal, or switch Claude's Mochi to an Anthropic API key in Settings.",
        true,
    ))
}

/// An empty folder of Coucou's own, so Claude Code finds no project files there.
fn work_dir() -> Result<PathBuf, ChatError> {
    let dir = settings::local_dir().join("mochi").join("claude-chat");
    std::fs::create_dir_all(&dir).map_err(|_| ChatError::new(
        "cli",
        "Could not prepare Claude's Mochi folder. Check that Coucou can write to its data folder.",
        false,
    ))?;
    Ok(dir)
}

fn system_prompt() -> String {
    format!(
        "{}\nYou are answering in a small chat bubble on the user's screen, not working in a project: \
only read a file when the user attached it, and otherwise use only web search and web pages. \
The bubble shows plain text: when you cite sources, write their plain URLs, never Markdown links.\n",
        claude::SYSTEM_PROMPT,
    )
}

/// One turn's arguments. The user's words arrive on stdin, so nothing they
/// typed ever reaches a command line. `--add-dir` comes last: it takes several
/// values.
fn print_args(system: &str, dirs: &[PathBuf]) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for arg in [
        "-p",
        // stream-json, so the plan windows come along with the answer.
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--restricted",
        "--safe-mode",
        "--settings", NO_HOOKS,
        "--permission-mode", "dontAsk",
        "--tools", TOOLS,
        "--allowedTools", TOOLS,
        "--effort", "low",
        "--system-prompt",
    ] {
        args.push(arg.into());
    }
    args.push(system.into());
    for dir in dirs {
        args.push("--add-dir".into());
        args.push(dir.into());
    }
    args
}

fn command(claude: &Path, dir: &Path, args: Vec<OsString>) -> Command {
    let mut cmd = Command::new(claude);
    cmd.current_dir(dir).args(args);
    for name in CLEARED_ENV {
        cmd.env_remove(name);
    }
    platform::no_console(&mut cmd);
    cmd
}

/// Claude Code keeps no session for these chats, so each turn carries the
/// conversation so far.
fn prompt(history: &[Value], turn: &str) -> String {
    if history.is_empty() {
        return turn.to_string();
    }
    let mut text = String::from("Conversation so far:\n");
    for message in history {
        let who = if message["role"] == "assistant" { "Mochi" } else { "User" };
        text.push_str(&format!("\n{who}: {}\n", message["content"].as_str().unwrap_or("")));
    }
    text.push_str("\nThe user's new message:\n");
    text.push_str(turn);
    text
}

/// Folders of the files attached so far, so later turns can still read them.
fn readable_dirs(history: &[Value]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in history.iter().flat_map(|m| m["files"].as_array().cloned().unwrap_or_default()) {
        let Some(path) = path.as_str().map(PathBuf::from).filter(|p| p.is_file()) else { continue };
        if let Some(parent) = path.parent() {
            if !dirs.iter().any(|d| d == parent) {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    dirs
}

/// One chat turn with Claude's Mochi through `claude -p`.
pub async fn send(chat: &Chat, query: String, context: Option<ChatContext>) -> Result<ChatReply, ChatError> {
    let claude = claude_exe()?;
    let dir = work_dir()?;

    let mut turn = String::new();
    let mut files: Vec<String> = Vec::new();
    // Context rides along with the first message only, as with the APIs.
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                match file_input(path) {
                    FileInput::Text(text) => turn.push_str(&format!("File contents:\n{text}\n\n")),
                    // Images, PDFs and large files: Claude Code reads them itself.
                    FileInput::Image | FileInput::Reference => {
                        files.push(path.clone());
                        turn.push_str(&format!("The user attached the file at {path}. Read it with the Read tool.\n"));
                    }
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

    let (generation, history) = chat.begin(json!({ "role": "user", "content": turn.clone(), "files": files }));
    let dirs = readable_dirs(&history);
    let text = prompt(&history[..history.len() - 1], &turn);

    let result = tauri::async_runtime::spawn_blocking(move || run(&claude, &dir, &text, &dirs))
        .await
        .unwrap_or_else(|_| Err(ChatError::new("cli", "Claude Code stopped unexpectedly. Try again.", false)));
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

fn run(claude: &Path, dir: &Path, prompt: &str, dirs: &[PathBuf]) -> Result<String, ChatError> {
    let mut cmd = command(claude, dir, print_args(&system_prompt(), dirs));
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| ChatError::new(
        "cli",
        "Could not start Claude Code. Check that `claude` runs in a terminal.",
        false,
    ))?;
    // Both outputs are read on their own threads so a full pipe never stalls Claude Code.
    let stdout = read_all(child.stdout.take());
    let stderr = read_all(child.stderr.take());
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    } // dropped here: Claude Code sees the end of the prompt
    let status = wait(&mut child, TIMEOUT);
    let out = stdout.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let err = stderr.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    if status.is_none() {
        return Err(ChatError::new("timeout", "Claude Code did not answer within 4 minutes. Try again.", false));
    }
    note_plan(&out);
    outcome(&out, &err)
}

/// The result object, wherever it sits in the output (the last line of
/// stream-json, or the whole of `--output-format json`).
fn result_message(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    std::iter::once(trimmed)
        .chain(trimmed.lines().rev())
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|v| v["type"] == "result")
}

fn outcome(stdout: &str, stderr: &str) -> Result<String, ChatError> {
    let Some(result) = result_message(stdout) else {
        return Err(classify(&format!("{stdout}\n{stderr}"), None));
    };
    let text = result["result"].as_str().unwrap_or("").trim().to_string();
    let failed = result["is_error"].as_bool() == Some(true)
        || result["subtype"].as_str().is_some_and(|s| s != "success");
    if failed {
        return Err(classify(&text, result["api_error_status"].as_u64()));
    }
    if text.is_empty() {
        return Err(ChatError::new("response", "Claude Code returned no text. Try again.", false));
    }
    Ok(text)
}

/// Turns Claude Code's error text into an actionable message without echoing it.
fn classify(log: &str, status: Option<u64>) -> ChatError {
    let lower = log.to_lowercase();
    if lower.contains("limit reached") || lower.contains("hit your limit") || lower.contains("usage limit") {
        let message = match reset_time(log) {
            Some(time) => format!("Your Claude plan's usage limit was reached. Claude Code says it resets {time}."),
            None => "Your Claude plan's usage limit was reached. Try again later.".into(),
        };
        return ChatError::new("usage_limit", message, false);
    }
    if lower.contains("not logged in")
        || lower.contains("/login")
        || lower.contains("oauth token")
        || lower.contains("invalid api key")
        || lower.contains("authentication_error")
        || matches!(status, Some(401 | 403))
    {
        return ChatError::new(
            "missing_login",
            "Claude Code isn't signed in. Run `claude` in a terminal and sign in with your Claude account, then try again.",
            true,
        );
    }
    if lower.contains("unknown option") || lower.contains("unknown command") {
        return ChatError::new(
            "cli_outdated",
            "This Claude Code is too old for Claude's Mochi. Run `claude update` in a terminal, then try again.",
            false,
        );
    }
    if lower.contains("rate limit") || lower.contains("rate_limit") || lower.contains("overloaded") || matches!(status, Some(429 | 529)) {
        return ChatError::new("rate_limit", "Claude is busy right now. Wait a moment and try again.", false);
    }
    if lower.contains("connection error") || lower.contains("fetch failed") || lower.contains("econn") || lower.contains("enotfound") {
        return ChatError::new("network", "Claude Code could not reach Anthropic. Check your connection, proxy, or firewall and try again.", false);
    }
    ChatError::new("cli", "Claude Code could not answer. Check that `claude -p hi` works in a terminal, then try again.", false)
}

/// "resets 3pm (Europe/Paris)" → "3pm (Europe/Paris)": a short run of safe characters.
fn reset_time(log: &str) -> Option<String> {
    let lower = log.to_lowercase();
    let start = lower.find("resets ")? + "resets ".len();
    let time: String = log[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || " :,()/_+-".contains(*c))
        .take(40)
        .collect();
    let time = time.trim().to_string();
    (!time.is_empty() && time.chars().any(|c| c.is_ascii_digit())).then_some(time)
}

/// `claude auth status` prints JSON with `"loggedIn": true` once signed in.
fn logged_in(output: &str) -> bool {
    serde_json::from_str::<Value>(output.trim())
        .ok()
        .and_then(|v| v["loggedIn"].as_bool())
        .unwrap_or(false)
}

/// Checks that Claude Code is signed in, without sending a message.
pub async fn test_connection() -> Result<(), ChatError> {
    let claude = claude_exe()?;
    tauri::async_runtime::spawn_blocking(move || auth_status(&claude))
        .await
        .unwrap_or_else(|_| Err(ChatError::new("cli", "Claude Code stopped unexpectedly. Try again.", false)))
}

fn auth_status(claude: &Path) -> Result<(), ChatError> {
    let dir = work_dir()?;
    let mut cmd = command(claude, &dir, vec!["auth".into(), "status".into()]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| ChatError::new(
        "cli",
        "Could not start Claude Code. Check that `claude` runs in a terminal.",
        false,
    ))?;
    let stdout = read_all(child.stdout.take());
    let _stderr = read_all(child.stderr.take());
    // Signed out exits with 1, so the output decides, not the exit code.
    if wait(&mut child, STATUS_TIMEOUT).is_none() {
        return Err(ChatError::new("timeout", "Claude Code did not answer. Try again.", false));
    }
    let out = stdout.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    if logged_in(&out) {
        Ok(())
    } else {
        Err(classify("not logged in", None))
    }
}

/// How long the usage check may take.
const USAGE_TIMEOUT: Duration = Duration::from_secs(60);

/// The usage check's arguments: the smallest request Claude Code can make on
/// the plan — Haiku, no tools, no customizations (CLAUDE.md, plugins, MCP,
/// skills), a one-line system prompt, no session saved. About 400 input tokens.
/// `stream-json` carries the `rate_limit_event` with both plan windows.
fn usage_args() -> Vec<OsString> {
    [
        "-p",
        "--model", "haiku",
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--restricted",
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--exclude-dynamic-system-prompt-sections",
        "--settings", NO_HOOKS,
        "--tools", "",
        "--effort", "low",
        "--max-turns", "1",
        "--system-prompt", "Reply with one word.",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

/// The last `rate_limit_info` in Claude Code's stream-json output.
pub(crate) fn rate_limit_info(output: &str) -> Option<Value> {
    output
        .lines()
        .rev()
        .filter(|line| line.contains("rate_limit_event"))
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|message| message["type"] == "rate_limit_event")
        .and_then(|event| event.get("rate_limit_info").cloned())
}

/// Claude plan usage through Claude Code itself, for when no fresher numbers
/// came from the status line or Mochi: one tiny request whose answer carries
/// the plan windows. When the plan is at its limit the request is refused, and
/// the refusal still carries them.
pub(crate) fn plan_check() -> Option<Value> {
    let claude = claude_exe().ok()?;
    let dir = work_dir().ok()?;
    let mut cmd = command(&claude, &dir, usage_args());
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let stdout = read_all(child.stdout.take());
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"ok");
    }
    wait(&mut child, USAGE_TIMEOUT)?;
    let out = stdout.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    rate_limit_info(&out)
}

/// Mochi's own chats carry the plan windows too, at no extra cost.
fn note_plan(stdout: &str) {
    if let Some(info) = rate_limit_info(stdout) {
        crate::plan_usage::record_claude_info(&info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().to_string()).collect()
    }

    #[test]
    fn the_prompt_never_reaches_the_command_line() {
        let args = strings(&print_args("SYSTEM", &[PathBuf::from("C:/Users/me/Downloads")]));
        assert_eq!(args.first().map(String::as_str), Some("-p"));
        for flag in ["--restricted", "--safe-mode", "--no-session-persistence", "--verbose"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        let pairs = [
            ("--output-format", "stream-json"),
            ("--permission-mode", "dontAsk"),
            ("--tools", TOOLS),
            ("--allowedTools", TOOLS),
            ("--system-prompt", "SYSTEM"),
            ("--add-dir", "C:/Users/me/Downloads"),
        ];
        for (flag, value) in pairs {
            assert!(args.windows(2).any(|w| w[0] == flag && w[1] == value), "{flag} {value}");
        }
        let settings = args.windows(2).find(|w| w[0] == "--settings").map(|w| w[1].clone()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&settings).unwrap()["disableAllHooks"], true);
        assert_eq!(args.last().map(String::as_str), Some("C:/Users/me/Downloads"));
        assert!(!args.iter().any(|a| a.contains("danger") || a.contains("bypass") || a.contains("Bash")));
        assert!(!strings(&print_args("SYSTEM", &[])).iter().any(|a| a == "--add-dir"));
    }

    #[test]
    fn the_usage_check_is_the_smallest_request_and_its_plan_windows_are_found() {
        let args = strings(&usage_args());
        for (flag, value) in [("--model", "haiku"), ("--tools", ""), ("--max-turns", "1"), ("--output-format", "stream-json")] {
            assert!(args.windows(2).any(|w| w[0] == flag && w[1] == value), "{flag} {value}");
        }
        for flag in ["--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--verbose"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        // As Claude Code 2.1 writes it (one line per message).
        let output = concat!(
            r#"{"type":"system","subtype":"init"}"#, "\n",
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791702000,"rateLimitType":"seven_day","utilization":0.56,"unifiedWindows":{"five_hour":{"utilization":0.24,"resetsAt":1791238800},"seven_day":{"utilization":0.56,"resetsAt":1791702000}}}}"#, "\n",
            r#"{"type":"result","subtype":"success","result":"ok"}"#, "\n",
        );
        let info = rate_limit_info(output).unwrap();
        assert_eq!(info["unifiedWindows"]["five_hour"]["utilization"], 0.24);
        assert_eq!(rate_limit_info(r#"{"type":"result","result":"rate_limit_event"}"#), None);
    }

    #[test]
    fn claude_code_never_inherits_an_api_key() {
        let cmd = command(Path::new("claude"), Path::new("."), print_args("SYSTEM", &[]));
        let cleared: Vec<String> = cmd
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().to_string())
            .collect();
        for name in CLEARED_ENV {
            assert!(cleared.iter().any(|c| c == name), "{name}");
        }
    }

    #[test]
    fn each_turn_carries_the_conversation() {
        let history = vec![
            json!({ "role": "user", "content": "first question" }),
            json!({ "role": "assistant", "content": "first answer" }),
        ];
        let text = prompt(&history, "second question");
        let first = text.find("User: first question").unwrap();
        let answer = text.find("Mochi: first answer").unwrap();
        let second = text.find("second question").unwrap();
        assert!(first < answer && answer < second);
        assert_eq!(prompt(&[], "hello"), "hello");
        assert!(system_prompt().starts_with(claude::SYSTEM_PROMPT));
    }

    #[test]
    fn replies_and_errors_come_from_the_json_result() {
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":" pong \n"}"#;
        assert_eq!(outcome(ok, "").unwrap(), "pong");
        assert_eq!(outcome(&format!("warning: something\n{ok}\n"), "").unwrap(), "pong");

        let signed_out = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"result":"Not logged in · Please run /login"}"#;
        let err = outcome(signed_out, "").unwrap_err();
        assert_eq!(err.code, "missing_login");
        assert!(err.settings);

        let limit = r#"{"type":"result","subtype":"success","is_error":true,"result":"You've hit your limit · resets 3pm (Europe/Nicosia)"}"#;
        let err = outcome(limit, "").unwrap_err();
        assert_eq!(err.code, "usage_limit");
        assert!(err.message.ends_with("resets 3pm (Europe/Nicosia)."), "{}", err.message);
        assert_eq!(classify("Claude AI usage limit reached|1759550400", None).code, "usage_limit");

        let busy = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":529,"result":"API Error"}"#;
        assert_eq!(outcome(busy, "").unwrap_err().code, "rate_limit");
        assert_eq!(outcome("", "error: unknown option '--safe-mode'").unwrap_err().code, "cli_outdated");
        assert_eq!(classify("API Error: Connection error.", None).code, "network");

        let empty = r#"{"type":"result","subtype":"success","is_error":false,"result":""}"#;
        assert_eq!(outcome(empty, "").unwrap_err().code, "response");
        let unknown = outcome("panic: secret-sentinel", "secret-sentinel").unwrap_err();
        assert_eq!(unknown.code, "cli");
        assert!(!unknown.message.contains("secret-sentinel"));
        assert_eq!(reset_time("resets <script>"), None);
        assert_eq!(reset_time("resets https://x.y/5"), None);
        assert_eq!(reset_time("resets 5pm. See https://claude.ai"), Some("5pm".into()));
    }

    #[test]
    fn sign_in_is_read_from_auth_status() {
        assert!(logged_in("{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}\r\n"));
        assert!(!logged_in(r#"{"loggedIn": false, "authMethod": "none"}"#));
        assert!(!logged_in("Logged in"));
        assert!(!logged_in(""));
    }

    #[test]
    fn attached_files_stay_readable_in_later_turns() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-claude-cli-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("shot.png");
        std::fs::write(&file, b"x").unwrap();
        let path = file.to_string_lossy().to_string();
        let history = vec![
            json!({ "role": "user", "content": "look", "files": [path, path] }),
            json!({ "role": "assistant", "content": "seen" }),
            json!({ "role": "user", "content": "again", "files": ["C:/missing/file.pdf"] }),
        ];
        assert_eq!(readable_dirs(&history), vec![dir.clone()]);
        assert!(readable_dirs(&[json!({ "role": "user", "content": "hi" })]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "Runs the installed Claude Code's `claude auth status`; sends no message"]
    fn native_claude_sign_in_is_detected() {
        let claude = claude_exe().expect("Claude Code must be installed for this explicit test");
        auth_status(&claude).expect("Claude Code should report a sign-in");
    }

    #[test]
    #[ignore = "Sends one short question through `claude -p`; uses the signed-in Claude plan"]
    fn native_claude_print_answers() {
        let claude = claude_exe().expect("Claude Code must be installed for this explicit test");
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-claude-print-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        let answer = run(&claude, &dir, "Reply with exactly the word: pong", &[]);
        let _ = std::fs::remove_dir_all(&dir);
        let answer = answer.map_err(|e| e.message).expect("Claude Code should answer");
        assert!(answer.to_lowercase().contains("pong"), "{answer}");
    }
}
