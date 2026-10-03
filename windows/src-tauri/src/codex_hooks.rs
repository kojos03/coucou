// Codex hook installation — the Codex counterpart of hooks.rs, under the same
// rules: read ~/.codex/hooks.json, show the exact diff, take a dated backup and
// write only after an explicit click, leaving everything that is not Coucou's
// alone. Codex asks the user to review new or changed hooks (`/hooks`), so an
// entry that is already correct is never rewritten.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::hooks::{self, HookPreview};
use crate::{platform, settings};

/// The events the island follows. `PermissionRequest` is answered from the
/// island's Allow / Deny card; `Interrupt` tells it the user stopped a turn.
pub const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
    "SessionEnd",
];

/// Codex waits this long for an answer from the island before asking itself.
/// The relay gives up at 110 s, so Codex never hits its own timeout.
const APPROVAL_TIMEOUT: u64 = 120;
/// Shown in Codex while the island's card is waiting for a click.
const APPROVAL_STATUS: &str = "Waiting for your answer in Coucou";

/// Identifies a Coucou handler inside hooks.json.
const MARKER: &str = "coucou-hook";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStatus {
    pub event: String,
    /// "ok", "missing", or "outdated" (ours, but not what we would write).
    pub state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookStatus {
    pub path: String,
    pub exists: bool,
    /// Why the file cannot be used as it is (unreadable, invalid JSON…).
    pub problem: Option<String>,
    pub hook_path: String,
    pub hook_ready: bool,
    pub events: Vec<EventStatus>,
    /// Every event is registered exactly as Coucou would write it.
    pub installed: bool,
    /// At least one Coucou entry exists, correct or not.
    pub any_installed: bool,
    /// When the relay last delivered a Codex event (Unix seconds).
    pub last_event: Option<u64>,
}

/// `$CODEX_HOME/hooks.json`, by default `~/.codex/hooks.json`.
pub fn hooks_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| platform::home_dir().join(".codex"))
        .join("hooks.json")
}

/// The handler Coucou registers for `event`. Same shape as the hand-repaired
/// configuration that delivered Stop events: PowerShell needs the `&` call
/// operator before a quoted path, and SessionEnd runs synchronously so it is
/// delivered before Codex exits. PermissionRequest runs synchronously too, with
/// a long timeout: Codex reads the island's decision from its output.
fn handler(event: &str) -> Value {
    let exe = settings::hook_exe_path().to_string_lossy().to_string();
    let mut h = Map::new();
    h.insert("type".into(), json!("command"));
    #[cfg(windows)]
    {
        h.insert("command".into(), json!(format!("\"{exe}\" --agent codex {event}")));
        h.insert("commandWindows".into(), json!(format!("& \"{exe}\" --agent codex {event}")));
    }
    #[cfg(unix)]
    h.insert("command".into(), json!(format!("{} --agent codex {event}", hooks::sh_quote(&exe))));
    match event {
        "PermissionRequest" => {
            h.insert("timeout".into(), json!(APPROVAL_TIMEOUT));
            h.insert("statusMessage".into(), json!(APPROVAL_STATUS));
        }
        "SessionEnd" => {
            h.insert("timeout".into(), json!(3));
        }
        _ => {
            h.insert("timeout".into(), json!(3));
            h.insert("async".into(), json!(true));
        }
    }
    Value::Object(h)
}

fn is_ours(handler: &Value) -> bool {
    ["command", "commandWindows"].iter().any(|key| {
        handler.get(*key).and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))
    })
}

fn group_handlers(group: &Value) -> impl Iterator<Item = &Value> {
    group.get("hooks").and_then(Value::as_array).into_iter().flatten()
}

fn state_of(hooks: &Map<String, Value>, event: &str) -> &'static str {
    let groups = hooks.get(event).and_then(Value::as_array);
    let ours: Vec<(&Value, &Value)> = groups
        .into_iter()
        .flatten()
        .flat_map(|group| group_handlers(group).map(move |h| (group, h)))
        .filter(|(_, h)| is_ours(h))
        .collect();
    match ours.as_slice() {
        [] => "missing",
        [(group, h)] if **h == handler(event) && group.get("matcher").is_none() => "ok",
        _ => "outdated",
    }
}

/// Drops our handlers from an event's groups, and any group left empty by that.
fn strip_ours(groups: &mut Vec<Value>) {
    groups.retain_mut(|group| {
        let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else { return true };
        let before = list.len();
        list.retain(|h| !is_ours(h));
        !(list.is_empty() && before > 0)
    });
}

/// Refuses shapes we would have to overwrite to edit: a `hooks` that is not an
/// object, or an event that is not a list.
fn check_shape(root: &Value) -> Result<(), String> {
    let Some(hooks) = root.get("hooks") else { return Ok(()) };
    let Some(hooks) = hooks.as_object() else {
        return Err("\"hooks\" in hooks.json isn't an object. Fix or move the file — Coucou won't overwrite it.".into());
    };
    if let Some((event, _)) = hooks.iter().find(|(_, v)| !v.is_array()) {
        return Err(format!("\"{event}\" in hooks.json isn't a list. Fix or move the file — Coucou won't overwrite it."));
    }
    Ok(())
}

/// hooks.json with Coucou's entries in place; correct ones are left untouched.
fn merged(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_default();
    for event in EVENTS {
        if state_of(&hooks, event) == "ok" {
            continue;
        }
        let mut groups = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        strip_ours(&mut groups);
        groups.push(json!({ "hooks": [handler(event)] }));
        hooks.insert((*event).to_string(), Value::Array(groups));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// hooks.json with every Coucou handler removed and nothing else changed.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        let Some(groups) = value.as_array() else {
            out.insert(event, value);
            continue;
        };
        let had_ours = groups.iter().flat_map(group_handlers).any(is_ours);
        let mut kept = groups.clone();
        strip_ours(&mut kept);
        if !(kept.is_empty() && had_ours) {
            out.insert(event, Value::Array(kept));
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

fn read_at(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => hooks::parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

fn fingerprint_at(path: &Path) -> String {
    hooks::fingerprint(&std::fs::read(path).unwrap_or_default())
}

fn backup_for(path: &Path) -> PathBuf {
    path.with_file_name(format!("hooks.json.bak-coucou-{}", hooks::stamp()))
}

fn next_for(current: &Value, install: bool) -> Value {
    if install { merged(current) } else { without_ours(current) }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status() -> CodexHookStatus {
    status_at(&hooks_path())
}

fn status_at(path: &Path) -> CodexHookStatus {
    let (current, problem) = match read_at(path).and_then(|v| check_shape(&v).map(|_| v)) {
        Ok(value) => (value, None),
        Err(err) => (json!({}), Some(err)),
    };
    let hooks = current.get("hooks").and_then(Value::as_object).cloned().unwrap_or_default();
    let events: Vec<EventStatus> = EVENTS
        .iter()
        .map(|event| EventStatus { event: (*event).to_string(), state: state_of(&hooks, event) })
        .collect();
    let hook_path = settings::hook_exe_path();
    CodexHookStatus {
        path: path.to_string_lossy().to_string(),
        exists: path.exists(),
        installed: problem.is_none() && events.iter().all(|e| e.state == "ok"),
        any_installed: events.iter().any(|e| e.state != "missing"),
        problem,
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
        events,
        last_event: crate::pipe::last_event("codex"),
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    preview_at(&hooks_path(), install)
}

fn preview_at(path: &Path, install: bool) -> Result<HookPreview, String> {
    let current = read_at(path)?;
    check_shape(&current)?;
    let next = next_for(&current, install);
    Ok(HookPreview {
        diff: hooks::unified_diff(&hooks::pretty(&current), &hooks::pretty(&next)),
        backup: backup_for(path).to_string_lossy().to_string(),
        settings_path: path.to_string_lossy().to_string(),
        fingerprint: fingerprint_at(path),
    })
}

/// Writes the merged (or cleaned) hooks.json after a dated backup. Returns the
/// backup path, or an empty string when there was no file to back up or
/// nothing needed to change.
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    write_at(&hooks_path(), install, fingerprint)
}

fn write_at(path: &Path, install: bool, fingerprint: &str) -> Result<String, String> {
    let current = read_at(path)?;
    check_shape(&current)?;
    if fingerprint_at(path) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }
    let next = next_for(&current, install);
    if next == current {
        return Ok(String::new());
    }

    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("write failed: {e}"))?;
    let backup = if path.exists() {
        let backup = backup_for(path);
        std::fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;
        backup.to_string_lossy().to_string()
    } else {
        String::new()
    };

    let mut text = hooks::pretty(&next);
    text.push('\n');
    #[cfg(unix)]
    let path = &std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // Beside the target, then renamed over it: a failed write leaves the
    // original hooks.json intact.
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    if let Err(err) = hooks::write_like(&temp, path, text.as_bytes()) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    if let Err(err) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-codex-hooks-{name}-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn foreign() -> Value {
        json!({ "type": "command", "command": "notify-send done", "timeout": 5 })
    }

    #[test]
    fn a_complete_installation_is_recognised_and_left_alone() {
        let installed = merged(&json!({ "description": "mine" }));
        let hooks = installed["hooks"].as_object().unwrap();
        assert!(EVENTS.iter().all(|e| state_of(hooks, e) == "ok"));
        assert_eq!(merged(&installed), installed);
        assert_eq!(installed["description"], "mine");
        let session_end = &installed["hooks"]["SessionEnd"][0]["hooks"][0];
        assert!(session_end.get("async").is_none());
        assert_eq!(installed["hooks"]["Stop"][0]["hooks"][0]["async"], true);
        assert_eq!(installed["hooks"]["Interrupt"][0]["hooks"][0]["async"], true);
        // Codex reads the decision from a PermissionRequest handler's output, so
        // it must run synchronously and outlast the relay's 110 s wait.
        let approval = &installed["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert!(approval.get("async").is_none());
        assert!(approval["timeout"].as_u64().unwrap() > 110);
        assert_eq!(approval["statusMessage"], APPROVAL_STATUS);
        assert!(approval["command"].as_str().unwrap().ends_with("--agent codex PermissionRequest"));
        #[cfg(windows)]
        assert!(installed["hooks"]["Stop"][0]["hooks"][0]["commandWindows"].as_str().unwrap().starts_with("& \""));
    }

    #[test]
    fn repair_replaces_only_broken_coucou_entries_and_keeps_foreign_hooks() {
        let mut broken = handler("Stop");
        broken["commandWindows"] = json!("\"C:\\old\\coucou-hook.exe\" --agent codex Stop");
        let current = json!({
            "custom": { "kept": true },
            "hooks": {
                "Stop": [{ "hooks": [broken, foreign()] }],
                "PreCompact": [{ "matcher": "auto", "hooks": [foreign()] }],
            }
        });
        let hooks = current["hooks"].as_object().unwrap();
        assert_eq!(state_of(hooks, "Stop"), "outdated");
        assert_eq!(state_of(hooks, "SessionStart"), "missing");

        let next = merged(&current);
        assert_eq!(next["custom"], json!({ "kept": true }));
        assert_eq!(next["hooks"]["PreCompact"], current["hooks"]["PreCompact"]);
        assert_eq!(next["hooks"]["Stop"][0]["hooks"], json!([foreign()]));
        assert_eq!(next["hooks"]["Stop"][1]["hooks"], json!([handler("Stop")]));
        assert!(EVENTS.iter().all(|e| state_of(next["hooks"].as_object().unwrap(), e) == "ok"));
    }

    #[test]
    fn the_earlier_eight_event_installation_needs_only_the_two_new_events() {
        // What Coucou wrote before approvals: everything but PermissionRequest
        // and Interrupt. Repair adds those two and leaves the rest byte-identical,
        // so Codex only asks the user to review the new entries.
        let mut earlier = merged(&json!({}));
        let hooks = earlier["hooks"].as_object_mut().unwrap();
        hooks.remove("PermissionRequest");
        hooks.remove("Interrupt");
        let status: Vec<_> = EVENTS.iter().map(|e| (*e, state_of(hooks, e))).collect();
        assert_eq!(
            status.iter().filter(|(_, s)| *s == "missing").map(|(e, _)| *e).collect::<Vec<_>>(),
            vec!["PermissionRequest", "Interrupt"],
        );
        let repaired = merged(&earlier);
        for event in EVENTS.iter().filter(|e| !matches!(**e, "PermissionRequest" | "Interrupt")) {
            assert_eq!(repaired["hooks"][*event], earlier["hooks"][*event], "{event}");
        }
        assert!(EVENTS.iter().all(|e| state_of(repaired["hooks"].as_object().unwrap(), e) == "ok"));
    }

    #[test]
    fn duplicates_are_outdated_and_collapse_to_one_entry() {
        let current = json!({ "hooks": { "Stop": [
            { "hooks": [handler("Stop")] },
            { "hooks": [handler("Stop")] },
        ] } });
        assert_eq!(state_of(current["hooks"].as_object().unwrap(), "Stop"), "outdated");
        assert_eq!(merged(&current)["hooks"]["Stop"], json!([{ "hooks": [handler("Stop")] }]));
    }

    #[test]
    fn removal_takes_only_coucou_handlers() {
        let installed = merged(&json!({
            "description": "mine",
            "hooks": { "Stop": [{ "hooks": [foreign()] }], "PreCompact": [] },
        }));
        let removed = without_ours(&installed);
        assert_eq!(removed["description"], "mine");
        assert_eq!(removed["hooks"]["Stop"], json!([{ "hooks": [foreign()] }]));
        assert_eq!(removed["hooks"]["PreCompact"], json!([]));
        assert!(removed["hooks"].get("SessionStart").is_none());
        assert_eq!(without_ours(&merged(&json!({}))), json!({}));
    }

    #[test]
    fn shapes_that_would_need_overwriting_are_refused() {
        assert!(check_shape(&json!({ "hooks": [] })).is_err());
        assert!(check_shape(&json!({ "hooks": { "Stop": {} } })).is_err());
        assert!(check_shape(&json!({ "hooks": { "Stop": [] } })).is_ok());
        assert!(check_shape(&json!({})).is_ok());
    }

    #[test]
    fn writing_backs_up_checks_the_preview_and_skips_no_ops() {
        let dir = temp_dir("write");
        let path = dir.join("hooks.json");
        // No file yet: installing creates it without a backup.
        let preview = preview_at(&path, true).unwrap();
        assert!(preview.diff.contains("coucou-hook"));
        assert_eq!(write_at(&path, true, &preview.fingerprint).unwrap(), "");
        assert!(status_at(&path).installed);
        // Installing again changes nothing and writes nothing.
        let unchanged = std::fs::read(&path).unwrap();
        let again = preview_at(&path, true).unwrap();
        assert_eq!(again.diff, "No change.");
        assert_eq!(write_at(&path, true, &again.fingerprint).unwrap(), "");
        assert_eq!(std::fs::read(&path).unwrap(), unchanged);
        // A file edited after the preview is never overwritten.
        let stale = preview_at(&path, false).unwrap();
        std::fs::write(&path, b"{\"hooks\":{}}\n").unwrap();
        assert!(write_at(&path, false, &stale.fingerprint).is_err());
        // Malformed JSON stops before any backup or write.
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(preview_at(&path, true).is_err());
        assert!(status_at(&path).problem.is_some());
        let fresh = fingerprint_at(&path);
        assert!(write_at(&path, true, &fresh).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not json");
        // Removal backs the previous file up.
        std::fs::write(&path, hooks::pretty(&merged(&json!({})))).unwrap();
        let removal = preview_at(&path, false).unwrap();
        let backup = write_at(&path, false, &removal.fingerprint).unwrap();
        assert!(std::path::Path::new(&backup).exists());
        assert!(!status_at(&path).any_installed);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
