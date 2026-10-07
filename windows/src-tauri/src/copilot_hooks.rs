// GitHub Copilot CLI hook installation — the Copilot counterpart of
// codex_hooks.rs, under the same rules: show the exact diff, take a dated
// backup and write only after an explicit click, leave what is not Coucou's
// alone. Copilot reads every JSON file in ~/.copilot/hooks/, so Coucou keeps
// its entries in a file of its own, coucou.json, as on macOS.
//
// Copilot's format differs from Claude Code's and Codex's: camelCase event
// names, one flat list of commands per event, and a command per shell —
// `powershell` on Windows, `bash` elsewhere.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::codex_hooks::{CodexHookStatus as AgentHookStatus, EventStatus};
use crate::hooks::{self, HookPreview};
use crate::{platform, settings};

/// The events the island follows, with Copilot's timeouts (seconds). The relay
/// gives a permission request up after 110 s, inside Copilot's 120.
pub const EVENTS: &[(&str, u64)] = &[
    ("sessionStart", 10),
    ("userPromptSubmitted", 10),
    ("preToolUse", 10),
    ("permissionRequest", 120),
    ("postToolUse", 10),
    ("agentStop", 10),
    ("sessionEnd", 3),
    ("notification", 10),
];

/// Identifies a Coucou command inside the file.
const MARKER: &str = "coucou-hook";
/// The keys a Copilot command can live under.
const COMMAND_KEYS: &[&str] = &["powershell", "bash", "command"];

/// `$COPILOT_HOME/hooks/coucou.json`, by default `~/.copilot/hooks/coucou.json`.
pub fn hooks_path() -> PathBuf {
    std::env::var_os("COPILOT_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| platform::home_dir().join(".copilot"))
        .join("hooks")
        .join("coucou.json")
}

/// The entry Coucou registers for `event`. PowerShell needs the `&` call
/// operator before a quoted path, as Codex's hooks do.
fn handler(event: &str, timeout: u64) -> Value {
    let exe = settings::hook_exe_path().to_string_lossy().to_string();
    let mut h = Map::new();
    h.insert("type".into(), json!("command"));
    #[cfg(windows)]
    h.insert("powershell".into(), json!(format!("& \"{exe}\" --agent copilot {event}")));
    #[cfg(unix)]
    h.insert("bash".into(), json!(format!("{} --agent copilot {event}", hooks::sh_quote(&exe))));
    h.insert("timeoutSec".into(), json!(timeout));
    Value::Object(h)
}

fn is_ours(entry: &Value) -> bool {
    COMMAND_KEYS.iter().any(|key| entry.get(*key).and_then(Value::as_str).is_some_and(|c| c.contains(MARKER)))
}

fn state_of(hooks: &Map<String, Value>, event: &str, timeout: u64) -> &'static str {
    let ours: Vec<&Value> = hooks
        .get(event)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| is_ours(entry))
        .collect();
    match ours.as_slice() {
        [] => "missing",
        [entry] if **entry == handler(event, timeout) => "ok",
        _ => "outdated",
    }
}

/// Refuses shapes we would have to overwrite to edit: a `hooks` that is not an
/// object, or an event that is not a list.
fn check_shape(root: &Value) -> Result<(), String> {
    if !root.is_object() {
        return Err("coucou.json isn't a JSON object. Fix or move the file — Coucou won't overwrite it.".into());
    }
    let Some(hooks) = root.get("hooks") else { return Ok(()) };
    let Some(hooks) = hooks.as_object() else {
        return Err("\"hooks\" in coucou.json isn't an object. Fix or move the file — Coucou won't overwrite it.".into());
    };
    if let Some((event, _)) = hooks.iter().find(|(_, v)| !v.is_array()) {
        return Err(format!("\"{event}\" in coucou.json isn't a list. Fix or move the file — Coucou won't overwrite it."));
    }
    Ok(())
}

/// The file with Coucou's entries in place; correct ones are left untouched.
fn merged(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_default();
    for (event, timeout) in EVENTS {
        if state_of(&hooks, event, *timeout) == "ok" {
            continue;
        }
        let mut entries = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        entries.retain(|entry| !is_ours(entry));
        entries.push(handler(event, *timeout));
        hooks.insert((*event).to_string(), Value::Array(entries));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    root.entry("version").or_insert(json!(1));
    Value::Object(root)
}

/// The file with every Coucou entry removed and nothing else changed.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        let Some(entries) = value.as_array() else {
            out.insert(event, value);
            continue;
        };
        let had_ours = entries.iter().any(is_ours);
        let kept: Vec<Value> = entries.iter().filter(|entry| !is_ours(entry)).cloned().collect();
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

/// Nothing left but the format version: the file is Coucou's alone and can go.
fn only_version(root: &Value) -> bool {
    root.as_object().is_some_and(|map| map.keys().all(|key| key == "version"))
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

/// Beside the file but not ending in .json, so Copilot never loads the backup
/// as a second set of hooks.
fn backup_for(path: &Path) -> PathBuf {
    path.with_file_name(format!("coucou.json.bak-coucou-{}", hooks::stamp()))
}

fn next_for(current: &Value, install: bool) -> Value {
    if install { merged(current) } else { without_ours(current) }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status() -> AgentHookStatus {
    status_at(&hooks_path())
}

fn status_at(path: &Path) -> AgentHookStatus {
    let (current, problem) = match read_at(path).and_then(|v| check_shape(&v).map(|_| v)) {
        Ok(value) => (value, None),
        Err(err) => (json!({}), Some(err)),
    };
    let hooks = current.get("hooks").and_then(Value::as_object).cloned().unwrap_or_default();
    let events: Vec<EventStatus> = EVENTS
        .iter()
        .map(|(event, timeout)| EventStatus { event: (*event).to_string(), state: state_of(&hooks, event, *timeout) })
        .collect();
    let hook_path = settings::hook_exe_path();
    AgentHookStatus {
        path: path.to_string_lossy().to_string(),
        exists: path.exists(),
        installed: problem.is_none() && events.iter().all(|e| e.state == "ok"),
        any_installed: events.iter().any(|e| e.state != "missing"),
        problem,
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
        events,
        last_event: crate::pipe::last_event("copilot"),
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    preview_at(&hooks_path(), install)
}

fn preview_at(path: &Path, install: bool) -> Result<HookPreview, String> {
    let current = read_at(path)?;
    check_shape(&current)?;
    let next = next_for(&current, install);
    let after = if !install && only_version(&next) && path.exists() {
        format!("(deletes {})", path.display())
    } else {
        hooks::pretty(&next)
    };
    let before = if path.exists() { hooks::pretty(&current) } else { String::new() };
    Ok(HookPreview {
        diff: if next == current { "No change.".into() } else { hooks::unified_diff(&before, &after) },
        backup: backup_for(path).to_string_lossy().to_string(),
        settings_path: path.to_string_lossy().to_string(),
        fingerprint: fingerprint_at(path),
    })
}

/// Writes coucou.json after a dated backup, or deletes it when removal leaves
/// nothing of anyone's in it. Returns the backup path, or an empty string when
/// there was no file to back up or nothing needed to change.
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

    if !install && only_version(&next) {
        std::fs::remove_file(path).map_err(|e| format!("remove failed: {e}"))?;
        return Ok(backup);
    }

    let mut text = hooks::pretty(&next);
    text.push('\n');
    #[cfg(unix)]
    let path = &std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // Beside the target, then renamed over it: a failed write leaves the
    // original intact. Not ending in .json, so Copilot never loads it.
    let temp = path.with_file_name(format!("coucou.json.coucou-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("coucou-copilot-hooks-{name}-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn foreign() -> Value {
        json!({ "type": "command", "bash": "./scripts/audit.sh", "powershell": "./scripts/audit.ps1", "timeoutSec": 5 })
    }

    #[test]
    fn the_entries_follow_copilots_format() {
        let installed = merged(&json!({}));
        assert_eq!(installed["version"], 1);
        let hooks = installed["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), EVENTS.len());
        let entry = &hooks["permissionRequest"][0];
        assert_eq!(entry["type"], "command");
        assert_eq!(entry["timeoutSec"], 120);
        assert_eq!(hooks["sessionEnd"][0]["timeoutSec"], 3);
        #[cfg(windows)]
        {
            let cmd = entry["powershell"].as_str().unwrap();
            assert!(cmd.starts_with("& \"") && cmd.ends_with("\" --agent copilot permissionRequest"), "{cmd}");
            assert!(entry.get("bash").is_none());
        }
        #[cfg(unix)]
        assert!(entry["bash"].as_str().unwrap().ends_with(" --agent copilot permissionRequest"));
        assert!(status_from(&installed).installed);
    }

    fn status_from(root: &Value) -> AgentHookStatus {
        let dir = temp_dir("status");
        let path = dir.join("coucou.json");
        std::fs::write(&path, hooks::pretty(root)).unwrap();
        let status = status_at(&path);
        let _ = std::fs::remove_dir_all(&dir);
        status
    }

    #[test]
    fn repair_replaces_only_coucou_entries_and_keeps_foreign_ones() {
        let mut stale = merged(&json!({}));
        stale["hooks"]["preToolUse"] = json!([foreign(), { "type": "command", "bash": "/old/coucou-hook --agent copilot preToolUse", "timeoutSec": 10 }]);
        stale["hooks"]["agentStop"] = json!([]);
        stale["description"] = json!("mine");
        let status = status_from(&stale);
        assert!(!status.installed && status.any_installed);
        let states: Vec<_> = status.events.iter().filter(|e| e.state != "ok").map(|e| (e.event.as_str(), e.state)).collect();
        assert_eq!(states, [("preToolUse", "outdated"), ("agentStop", "missing")]);

        let repaired = merged(&stale);
        assert_eq!(repaired["description"], "mine");
        assert_eq!(repaired["hooks"]["preToolUse"], json!([foreign(), handler("preToolUse", 10)]));
        assert_eq!(repaired["hooks"]["agentStop"], json!([handler("agentStop", 10)]));
        assert!(status_from(&repaired).installed);
        // An installation that is already right is not touched.
        assert_eq!(merged(&repaired), repaired);
    }

    #[test]
    fn removal_takes_only_coucou_entries() {
        let mut mixed = merged(&json!({}));
        mixed["hooks"]["sessionStart"].as_array_mut().unwrap().insert(0, foreign());
        let cleaned = without_ours(&mixed);
        assert_eq!(cleaned, json!({ "version": 1, "hooks": { "sessionStart": [foreign()] } }));
        assert!(!only_version(&cleaned));
        assert!(only_version(&without_ours(&merged(&json!({})))));
    }

    #[test]
    fn shapes_that_would_need_overwriting_are_refused() {
        assert!(check_shape(&json!({ "hooks": [] })).is_err());
        assert!(check_shape(&json!({ "hooks": { "preToolUse": {} } })).is_err());
        assert!(check_shape(&json!([1])).is_err());
        assert!(check_shape(&json!({ "version": 1 })).is_ok());
    }

    #[test]
    fn writing_backs_up_checks_the_preview_and_deletes_an_emptied_file() {
        let dir = temp_dir("write");
        let path = dir.join("hooks").join("coucou.json");
        // No folder or file yet: installing creates both, without a backup.
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
        std::fs::write(&path, &unchanged[..unchanged.len() - 1]).unwrap();
        assert!(write_at(&path, false, &stale.fingerprint).is_err());
        // Malformed JSON stops before any backup or write.
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(preview_at(&path, true).is_err());
        assert!(status_at(&path).problem.is_some());
        assert!(write_at(&path, true, &fingerprint_at(&path)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not json");
        // Removing everything backs the file up, then deletes it.
        std::fs::write(&path, hooks::pretty(&merged(&json!({})))).unwrap();
        let removal = preview_at(&path, false).unwrap();
        assert!(removal.diff.contains("(deletes "), "{}", removal.diff);
        let backup = write_at(&path, false, &removal.fingerprint).unwrap();
        assert!(Path::new(&backup).exists());
        assert!(!backup.ends_with(".json"), "Copilot must not load the backup: {backup}");
        assert!(!path.exists());
        assert!(!status_at(&path).any_installed);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
