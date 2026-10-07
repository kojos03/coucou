//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook [--agent <name>] <EventName>` (the name is also read
//! from the JSON), or `coucou-hook --statusline` as Claude Code's status line
//! (see statusline.rs). Other agents' event names and fields are mapped to
//! Claude Code's (`normalize_event`), and each agent gets its decision in its
//! own format (`decision_json`).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "toolResult", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

mod statusline;

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--statusline") {
        statusline::run();
        std::process::exit(0);
    }
    let (agent, arg_event) = parse_args(std::env::args().skip(1));
    if let Some(json) = respond(&agent, &arg_event) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }
    std::process::exit(0);
}

/// `coucou-hook [--agent <name>] [<EventName>]`. `--agent` tags the payload
/// with `coucou_agent` so the app routes it to the right pill; absent or
/// invalid names are validated and discarded by the app, not here. The event
/// name is a fallback for agents whose payload does not carry one.
fn parse_args(args: impl Iterator<Item = String>) -> (String, String) {
    let mut agent = String::new();
    let mut arg_event = String::new();
    let mut it = args;
    while let Some(arg) = it.next() {
        if arg == "--agent" {
            agent = it.next().unwrap_or_default();
        } else if arg_event.is_empty() {
            arg_event = arg;
        }
    }
    (agent, arg_event)
}

/// What to print on stdout, if anything.
fn respond(agent: &str, arg_event: &str) -> Option<String> {
    let Some((payload, event)) = read_event(agent, arg_event) else { return no_decision(agent) };

    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision, agent) {
            return Some(json);
        }
    }
    // No decision: the agent asks in its own terminal, as if we were not here.
    no_decision(agent)
}

/// Copilot CLI, Muse Code, Gemini CLI and Antigravity read a JSON object from
/// every hook; `{}` means "no decision". Copilot treats anything else as a
/// failed hook, so they get it on every path. Claude Code and Codex get nothing.
fn no_decision(agent: &str) -> Option<String> {
    matches!(agent, "copilot" | "muse" | "gemini" | "antigravity").then(|| "{}".to_string())
}

/// The island's word in the agent's own format. Anything we do not recognise
/// prints nothing at all rather than guessing — silence is the safe answer.
/// Claude Code and Codex: https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str, agent: &str) -> Option<String> {
    // "always" still answers a plain allow; remembering it is the island's
    // business, not the agent's.
    let allow = match decision.trim() {
        "allow" | "always" => true,
        "deny" => false,
        _ => return None,
    };
    let word = if allow { "allow" } else { "deny" };
    Some(match agent {
        // Copilot CLI's permissionRequest reads `behavior`; Coucou on macOS
        // answers `permissionDecision`, the preToolUse field. Both, so either
        // build of Copilot reads the decision.
        "copilot" => format!(r#"{{"behavior":"{word}","permissionDecision":"{word}"}}"#),
        "muse" => format!(r#"{{"permissionDecision":"{word}"}}"#),
        _ => {
            let behavior = if allow {
                r#"{"behavior":"allow"}"#
            } else {
                r#"{"behavior":"deny","message":"Denied from Coucou"}"#
            };
            format!(r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#)
        }
    })
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event(agent: &str, arg_event: &str) -> Option<(String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    prepare(&raw, agent, arg_event)
}

/// Other agents' event names → the canonical (Claude Code) ones, as the macOS
/// relay maps them: Gemini CLI, Antigravity, Muse Code's snake_case and
/// Copilot CLI's camelCase. Canonical names pass through.
fn normalize_event(name: &str) -> &str {
    match name {
        "BeforeTool" | "BeforeToolSelection" | "pre_tool_use" | "preToolUse" => "PreToolUse",
        "AfterTool" | "AfterModel" | "PostInvocation" | "post_tool_use" | "postToolUse" => "PostToolUse",
        "BeforeAgent" | "PreInvocation" | "user_prompt_submit" | "userPromptSubmitted" => "UserPromptSubmit",
        "AfterAgent" | "stop" | "agentStop" => "Stop",
        "startup" | "session_start" | "sessionStart" => "SessionStart",
        "exit" | "session_end" | "sessionEnd" => "SessionEnd",
        "notification" => "Notification",
        "permissionRequest" => "PermissionRequest",
        other => other,
    }
}

/// Copilot CLI sends `toolName`, `toolArgs`, `sessionId` and `workdir`; Gemini
/// CLI and Antigravity nest the tool in `toolCall`. The island reads Claude
/// Code's names, so the missing ones are filled in from these.
fn normalize_tool_fields(map: &mut serde_json::Map<String, serde_json::Value>) {
    use serde_json::Value;
    let text = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);

    if !map.contains_key("tool_name") {
        let call = map.get("toolCall").filter(|v| v.is_object());
        let name = text(map.get("toolName"))
            .or_else(|| text(call.and_then(|c| c.get("name"))))
            .or_else(|| text(map.get("tool")));
        if let Some(name) = name {
            map.insert("tool_name".into(), Value::String(name));
        }
    }
    if !map.contains_key("tool_input") {
        let input = match map.get("toolArgs") {
            Some(Value::Object(args)) => Some(Value::Object(args.clone())),
            // Some Copilot builds send the arguments as a JSON string.
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok().filter(Value::is_object),
            _ => map.get("toolCall").and_then(|c| c.get("args")).and_then(Value::as_object).map(|args| {
                let mut flat = args.clone();
                for (from, to) in [
                    ("CommandLine", "command"), ("FilePath", "file_path"), ("Path", "path"),
                    ("Url", "url"), ("Query", "query"), ("Pattern", "pattern"),
                ] {
                    if let Some(v) = args.get(from) {
                        flat.insert(to.into(), v.clone());
                    }
                }
                Value::Object(flat)
            }),
        };
        if let Some(input) = input {
            map.insert("tool_input".into(), input);
        }
    }
    if !map.contains_key("session_id") {
        let id = ["conversationId", "conversation_id", "sessionId", "GEMINI_SESSION_ID"]
            .iter()
            .find_map(|key| text(map.get(*key)))
            .or_else(|| std::env::var("GEMINI_SESSION_ID").ok().filter(|s| !s.is_empty()));
        if let Some(id) = id {
            map.insert("session_id".into(), Value::String(id));
        }
    }
    if text(map.get("cwd")).is_none() {
        let first = |key: &str| map.get(key).and_then(Value::as_array).and_then(|a| text(a.first()));
        let dir = text(map.get("workdir")).or_else(|| first("workspacePaths")).or_else(|| first("workspace_roots"));
        if let Some(dir) = dir {
            map.insert("cwd".into(), Value::String(dir));
        }
    }
}

/// The payload as the island expects it, one line, plus the canonical event.
fn prepare(raw: &[u8], agent: &str, arg_event: &str) -> Option<(String, String)> {
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);

    let mut payload = serde_json::from_slice::<serde_json::Value>(raw).ok()?;
    let map = payload.as_object_mut()?;

    let codex = agent == "codex";
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent.to_string()));
    }
    let raw_event = ["hook_event_name", "hookEventName"]
        .iter()
        .find_map(|key| map.get(*key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .unwrap_or(arg_event)
        .to_string();
    let event = normalize_event(&raw_event).to_string();
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));
    normalize_tool_fields(map);

    drop_fields(map, codex && event == "PermissionRequest");

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event))
}

/// Codex approvals keep the transcript path: Coucou reads from it whether the
/// chat's approvals go to Codex's own auto-review, and drops it before the
/// island sees the request.
fn drop_fields(map: &mut serde_json::Map<String, serde_json::Value>, codex_approval: bool) {
    for field in DROPPED_FIELDS {
        if !(codex_approval && *field == "transcript_path") {
            map.remove(*field);
        }
    }
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", "").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny", "codex").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always", "").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn copilot_and_muse_get_their_own_decision_format() {
        assert_eq!(decision_json("allow", "copilot").unwrap(), r#"{"behavior":"allow","permissionDecision":"allow"}"#);
        assert_eq!(decision_json("always", "copilot").unwrap(), r#"{"behavior":"allow","permissionDecision":"allow"}"#);
        assert_eq!(decision_json("deny", "copilot").unwrap(), r#"{"behavior":"deny","permissionDecision":"deny"}"#);
        assert_eq!(decision_json("allow", "muse").unwrap(), r#"{"permissionDecision":"allow"}"#);
        assert_eq!(decision_json("deny", "muse").unwrap(), r#"{"permissionDecision":"deny"}"#);
        for out in [decision_json("allow", "copilot"), decision_json("deny", "muse")] {
            assert!(serde_json::from_str::<Value>(&out.unwrap()).unwrap().is_object());
        }
    }

    #[test]
    fn json_agents_always_get_an_object_and_the_others_silence() {
        for agent in ["copilot", "muse", "gemini", "antigravity"] {
            assert_eq!(no_decision(agent).as_deref(), Some("{}"), "{agent}");
            assert!(decision_json("maybe", agent).is_none());
        }
        for agent in ["", "codex", "my-agent"] {
            assert!(no_decision(agent).is_none(), "{agent}");
        }
    }

    #[test]
    fn arguments_give_the_agent_and_the_fallback_event() {
        let args = |list: &[&str]| parse_args(list.iter().map(|s| s.to_string()));
        assert_eq!(args(&["--agent", "copilot", "preToolUse"]), ("copilot".into(), "preToolUse".into()));
        assert_eq!(args(&["Stop"]), ("".into(), "Stop".into()));
        assert_eq!(args(&["PreToolUse", "--agent", "muse"]), ("muse".into(), "PreToolUse".into()));
        assert_eq!(args(&["--agent"]), ("".into(), "".into()));
    }

    #[test]
    fn event_names_map_to_claude_codes() {
        for (from, to) in [
            ("sessionStart", "SessionStart"), ("userPromptSubmitted", "UserPromptSubmit"),
            ("preToolUse", "PreToolUse"), ("permissionRequest", "PermissionRequest"),
            ("postToolUse", "PostToolUse"), ("agentStop", "Stop"), ("sessionEnd", "SessionEnd"),
            ("notification", "Notification"), ("pre_tool_use", "PreToolUse"), ("stop", "Stop"),
            ("BeforeTool", "PreToolUse"), ("AfterAgent", "Stop"),
        ] {
            assert_eq!(normalize_event(from), to, "{from}");
        }
        // Claude Code's own names, and anything unknown, pass through.
        for name in ["PreToolUse", "Stop", "StopFailure", "Interrupt", "SubagentStart", "whatever"] {
            assert_eq!(normalize_event(name), name);
        }
    }

    fn prepared(payload: Value, agent: &str, arg_event: &str) -> (Value, String) {
        let (line, event) = prepare(payload.to_string().as_bytes(), agent, arg_event).unwrap();
        assert!(line.ends_with('\n'));
        (serde_json::from_str(line.trim_end()).unwrap(), event)
    }

    #[test]
    fn a_copilot_payload_reads_like_claude_codes() {
        let (p, event) = prepared(json!({
            "sessionId": "s-1", "timestamp": 1, "workdir": "C:/work/site", "cwd": "",
            "toolName": "bash", "toolArgs": { "command": "npm test" },
            "toolResult": { "textResultForLlm": "x".repeat(10_000) }
        }), "copilot", "preToolUse");
        assert_eq!(event, "PreToolUse");
        assert_eq!(p["hook_event_name"], "PreToolUse");
        assert_eq!(p["coucou_agent"], "copilot");
        assert_eq!(p["tool_name"], "bash");
        assert_eq!(p["tool_input"], json!({ "command": "npm test" }));
        assert_eq!(p["session_id"], "s-1");
        assert_eq!(p["cwd"], "C:/work/site");
        assert!(p.get("toolResult").is_none(), "results are never forwarded");

        // Arguments sent as a JSON string, and a permission request.
        let (p, event) = prepared(json!({
            "sessionId": "s-2", "cwd": "C:/w", "toolName": "write",
            "toolArgs": "{\"path\":\"a.txt\"}", "permission": { "kind": "toolUse" }
        }), "copilot", "permissionRequest");
        assert_eq!(event, "PermissionRequest");
        assert_eq!(p["tool_input"], json!({ "path": "a.txt" }));
        assert_eq!(p["cwd"], "C:/w");
    }

    #[test]
    fn the_payloads_own_event_name_wins_and_claude_code_is_untouched() {
        // Copilot's VS Code-compatible format and Muse send hook_event_name.
        let (p, event) = prepared(json!({ "hook_event_name": "UserPromptSubmit", "session_id": "m", "prompt": "hi", "cwd": "/w" }), "muse", "Stop");
        assert_eq!(event, "UserPromptSubmit");
        assert_eq!(p["session_id"], "m");
        let claude = json!({
            "hook_event_name": "PreToolUse", "session_id": "c", "cwd": "C:/p",
            "tool_name": "Bash", "tool_input": { "command": "ls" }
        });
        let (p, event) = prepared(claude.clone(), "", "");
        assert_eq!(event, "PreToolUse");
        for key in ["hook_event_name", "session_id", "cwd", "tool_name", "tool_input"] {
            assert_eq!(p[key], claude[key], "{key}");
        }
        assert!(p.get("coucou_agent").is_none());
    }

    #[test]
    fn gemini_tool_calls_are_flattened() {
        let (p, _) = prepared(json!({
            "conversationId": "g", "cwd": "/w",
            "toolCall": { "name": "run_shell_command", "args": { "CommandLine": "ls -la" } }
        }), "gemini", "BeforeTool");
        assert_eq!(p["tool_name"], "run_shell_command");
        assert_eq!(p["tool_input"]["command"], "ls -la");
        assert_eq!(p["session_id"], "g");
    }

    #[test]
    fn only_a_codex_approval_keeps_its_transcript_path() {
        let full = || serde_json::json!({ "transcript_path": "C:/t.jsonl", "tool_response": "big", "cwd": "C:/" });
        let mut codex = full();
        drop_fields(codex.as_object_mut().unwrap(), true);
        assert_eq!(codex, serde_json::json!({ "transcript_path": "C:/t.jsonl", "cwd": "C:/" }));
        let mut other = full();
        drop_fields(other.as_object_mut().unwrap(), false);
        assert_eq!(other, serde_json::json!({ "cwd": "C:/" }));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", "").is_none());
        assert!(decision_json("maybe", "").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, "").is_none());
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, "copilot").is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
