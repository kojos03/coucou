// Claude plan usage: the 5-hour and weekly windows Claude Code passes to its
// status line (`rate_limits`, Pro and Max plans), relayed by
// `coucou-hook --statusline`. A port of upstream #159.
//
// Two halves. The gauge: validated, kept in memory and in plan-usage.json so
// the pill survives a restart, and sent to the island. The installer: the
// `statusLine` key of ~/.claude/settings.json, under the hooks' rules (diff,
// dated backup, written only after an explicit click). A status line the user
// already had keeps running: it is saved beside the relay, which runs it and
// prints what it prints, and removing Coucou's puts it back exactly.
//
// This is Claude Code's own data about the plan; Coucou never touches the
// Claude sign-in for it.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::hooks::{self, HookPreview};
use crate::island::WINDOW_LABEL;
use crate::settings;

/// The relay looks for the saved status line under this name, beside itself.
const PREVIOUS_FILE: &str = "statusline-previous.json";
/// Marks Coucou's own status line command.
const FLAG: &str = "--statusline";
/// Claude Code sends Unix seconds; anything further out than this is a unit
/// mistake (milliseconds), not a reset time.
const MAX_AHEAD: u64 = 400 * 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    /// 0–100.
    pub used_pct: f64,
    /// Unix seconds.
    pub resets_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub five_hour: Option<PlanWindow>,
    pub seven_day: Option<PlanWindow>,
    /// Unix seconds of the reply that brought these numbers.
    pub updated_at: u64,
}

static LATEST: Mutex<Option<PlanUsage>> = Mutex::new(None);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The windows in a relayed status line payload, or None when it has none we
/// can trust (a Free plan, the session's first reply, malformed numbers).
pub fn parse(payload: &Value, now: u64) -> Option<PlanUsage> {
    let limits = payload.get("rate_limits")?;
    let five_hour = window(limits.get("five_hour"), now);
    let seven_day = window(limits.get("seven_day"), now);
    (five_hour.is_some() || seven_day.is_some()).then_some(PlanUsage { five_hour, seven_day, updated_at: now })
}

fn window(raw: Option<&Value>, now: u64) -> Option<PlanWindow> {
    let raw = raw?;
    let pct = raw.get("used_percentage")?.as_f64()?;
    // Slightly over 100 happens at the limit; far over is nonsense.
    if !(0.0..=200.0).contains(&pct) {
        return None;
    }
    let resets = raw.get("resets_at")?.as_f64()?;
    if !resets.is_finite() || resets <= 0.0 || resets > (now + MAX_AHEAD) as f64 {
        return None;
    }
    Some(PlanWindow { used_pct: pct.min(100.0), resets_at: resets as u64 })
}

fn usage_path() -> PathBuf {
    settings::local_dir().join("plan-usage.json")
}

/// The latest numbers, from memory or from the last run.
pub fn latest() -> Option<PlanUsage> {
    let mut latest = LATEST.lock().unwrap();
    if latest.is_none() {
        *latest = std::fs::read(usage_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PlanUsage>(&bytes).ok());
    }
    latest.clone()
}

/// A status line payload from the relay: keep and show what it says.
pub fn record(app: &AppHandle, payload: &Value) {
    let Some(usage) = parse(payload, now()) else { return };
    *LATEST.lock().unwrap() = Some(usage.clone());
    if let Ok(text) = serde_json::to_vec(&usage) {
        let _ = std::fs::write(usage_path(), text);
    }
    let _ = app.emit_to(WINDOW_LABEL, "plan-usage", usage);
}

// ── Installer ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRelayStatus {
    pub installed: bool,
    pub settings_path: String,
    pub hook_ready: bool,
    /// The user's own status line, which Coucou's keeps running.
    pub kept: Option<String>,
    /// A status line that is not Coucou's, in settings.json right now.
    pub other: Option<String>,
}

fn previous_path() -> PathBuf {
    settings::hook_exe_path().with_file_name(PREVIOUS_FILE)
}

fn command_of(status_line: Option<&Value>) -> Option<&str> {
    status_line?.get("command")?.as_str()
}

fn is_ours(status_line: Option<&Value>) -> bool {
    command_of(status_line).is_some_and(|c| c.contains("coucou-hook") && c.contains(FLAG))
}

fn saved_previous() -> Option<Value> {
    let bytes = std::fs::read(previous_path()).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object)
}

pub fn status() -> PlanRelayStatus {
    let current = hooks::read_settings().unwrap_or_else(|_| json!({}));
    let line = current.get("statusLine");
    let installed = is_ours(line);
    PlanRelayStatus {
        installed,
        settings_path: hooks::settings_path().to_string_lossy().to_string(),
        hook_ready: settings::hook_exe_path().exists(),
        kept: if installed { saved_previous().as_ref().and_then(|p| command_of(Some(p)).map(str::to_string)) } else { None },
        other: if installed { None } else { command_of(line).map(str::to_string) },
    }
}

/// What happens to the saved status line once settings.json is written.
#[derive(Debug, PartialEq)]
enum Saved {
    Untouched,
    Save(Value),
    Delete,
}

/// The new settings and what to do with the saved status line.
///
/// Installing over someone's own status line swaps only its `command`, so
/// `padding`, `refreshInterval` and the rest stay theirs, and saves the
/// original. Removing puts the original back, or drops the key when there was
/// none. A status line that is not Coucou's is never removed.
fn next_settings(current: &Value, install: bool, previous: Option<Value>, command: &str) -> (Value, Saved) {
    let mut root: Map<String, Value> = current.as_object().cloned().unwrap_or_default();
    let line = root.get("statusLine").cloned();
    let ours = is_ours(line.as_ref());
    if install {
        let mut updated = match &line {
            Some(Value::Object(object)) => object.clone(),
            _ => Map::new(),
        };
        updated.insert("type".into(), json!("command"));
        updated.insert("command".into(), json!(command));
        root.insert("statusLine".into(), Value::Object(updated));
        let saved = match line {
            _ if ours => Saved::Untouched,
            Some(original) if command_of(Some(&original)).is_some() => Saved::Save(original),
            // Nothing of the user's to keep: a stale copy must not run.
            _ => Saved::Delete,
        };
        (Value::Object(root), saved)
    } else if ours {
        match previous {
            Some(original) => root.insert("statusLine".into(), original),
            None => root.remove("statusLine"),
        };
        (Value::Object(root), Saved::Delete)
    } else {
        (Value::Object(root), Saved::Untouched)
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    let current = hooks::read_settings()?;
    let (next, _) = next_settings(&current, install, saved_previous(), &hooks::hook_command(FLAG));
    Ok(hooks::preview_of(&current, &next))
}

/// Writes the status line after a click, if settings.json is still what was
/// previewed. The user's own status line is saved before settings.json changes,
/// so it is never only in the backup.
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    let current = hooks::read_unchanged(fingerprint)?;
    let (next, saved) = next_settings(&current, install, saved_previous(), &hooks::hook_command(FLAG));
    let path = previous_path();
    match &saved {
        Saved::Save(original) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let text = serde_json::to_string_pretty(original).unwrap_or_default();
            std::fs::write(&path, text).map_err(|e| format!("Could not save your status line: {e}"))?;
        }
        Saved::Delete if install => remove(&path)?,
        _ => {}
    }
    let backup = hooks::replace_settings(&next)?;
    if saved == Saved::Delete && !install {
        remove(&path)?;
    }
    Ok(backup)
}

fn remove(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Could not remove {}: {err}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_000_000;
    const CMD: &str = "\"C:/Users/me/AppData/Local/Coucou/bin/coucou-hook.exe\" --statusline";

    #[test]
    fn plan_windows_are_validated_like_upstream() {
        let payload = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 23.5, "resets_at": NOW + 3600 },
            "seven_day": { "used_percentage": 140, "resets_at": NOW + 86_400 },
        }});
        let usage = parse(&payload, NOW).unwrap();
        assert_eq!(usage.five_hour, Some(PlanWindow { used_pct: 23.5, resets_at: NOW + 3600 }));
        // 100–200 is clamped, as at the very edge of the limit.
        assert_eq!(usage.seven_day.unwrap().used_pct, 100.0);
        assert_eq!(usage.updated_at, NOW);

        let bad = |five: Value| parse(&json!({ "rate_limits": { "five_hour": five } }), NOW);
        assert_eq!(bad(json!({ "used_percentage": 250, "resets_at": NOW })), None);
        assert_eq!(bad(json!({ "used_percentage": -1, "resets_at": NOW })), None);
        assert_eq!(bad(json!({ "used_percentage": "12", "resets_at": NOW })), None);
        assert_eq!(bad(json!({ "used_percentage": 12 })), None);
        // Milliseconds instead of seconds.
        assert_eq!(bad(json!({ "used_percentage": 12, "resets_at": NOW * 1000 })), None);
        assert_eq!(parse(&json!({ "rate_limits": {} }), NOW), None);
        assert_eq!(parse(&json!({}), NOW), None);
        // One good window is enough.
        let one = parse(&json!({ "rate_limits": {
            "five_hour": { "used_percentage": 900, "resets_at": NOW },
            "seven_day": { "used_percentage": 41, "resets_at": NOW + 10 },
        }}), NOW).unwrap();
        assert_eq!((one.five_hour, one.seven_day.map(|w| w.used_pct)), (None, Some(41.0)));
    }

    #[test]
    fn installing_adds_coucous_status_line_and_leaves_the_rest() {
        let current = json!({ "theme": "dark", "hooks": { "Stop": [] } });
        let (next, saved) = next_settings(&current, true, None, CMD);
        assert_eq!(next, json!({ "theme": "dark", "hooks": { "Stop": [] },
            "statusLine": { "type": "command", "command": CMD } }));
        assert_eq!(saved, Saved::Delete);
        assert!(is_ours(next.get("statusLine")));
    }

    #[test]
    fn a_users_own_status_line_is_kept_running_and_put_back() {
        let own = json!({ "type": "command", "command": "~/.claude/statusline.sh", "padding": 2, "refreshInterval": 5 });
        let current = json!({ "statusLine": own });
        let (installed, saved) = next_settings(&current, true, None, CMD);
        // Only the command changes: padding and refresh stay the user's.
        assert_eq!(installed["statusLine"], json!({ "type": "command", "command": CMD, "padding": 2, "refreshInterval": 5 }));
        assert_eq!(saved, Saved::Save(own.clone()));
        // Reinstalling (a moved relay) keeps the saved one.
        let (again, saved) = next_settings(&installed, true, Some(own.clone()), CMD);
        assert_eq!(again, installed);
        assert_eq!(saved, Saved::Untouched);
        // Removing restores it exactly.
        let (removed, saved) = next_settings(&installed, false, Some(own.clone()), CMD);
        assert_eq!(removed, json!({ "statusLine": own }));
        assert_eq!(saved, Saved::Delete);
        // Without a saved one, the key goes.
        let (removed, _) = next_settings(&installed, false, None, CMD);
        assert_eq!(removed, json!({}));
    }

    /// Installs and removes for real, in a sandbox: run with USERPROFILE and
    /// LOCALAPPDATA pointing at scratch folders and COUCOU_TEST_SANDBOX=1, so it
    /// can never touch the real ~/.claude/settings.json.
    #[test]
    #[ignore]
    fn native_install_and_remove_round_trip() {
        if std::env::var_os("COUCOU_TEST_SANDBOX").is_none() {
            return;
        }
        let settings_file = hooks::settings_path();
        std::fs::create_dir_all(settings_file.parent().unwrap()).unwrap();
        let own = json!({ "type": "command", "command": "echo mine", "padding": 1 });
        let original = format!("{}\n", serde_json::to_string_pretty(&json!({ "theme": "dark", "statusLine": own })).unwrap());
        std::fs::write(&settings_file, &original).unwrap();
        let _ = std::fs::remove_file(previous_path());

        let p = preview(true).unwrap();
        assert!(p.diff.contains("--statusline"), "{}", p.diff);
        // A file that changed after the preview is refused, untouched.
        std::fs::write(&settings_file, original.replace("dark", "light")).unwrap();
        assert!(write(true, &p.fingerprint).is_err());
        std::fs::write(&settings_file, &original).unwrap();
        let p = preview(true).unwrap();
        let backup = write(true, &p.fingerprint).unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
        let installed: Value = serde_json::from_slice(&std::fs::read(&settings_file).unwrap()).unwrap();
        assert!(is_ours(installed.get("statusLine")));
        assert_eq!(installed["statusLine"]["padding"], 1);
        assert_eq!(installed["theme"], "dark");
        assert_eq!(saved_previous(), Some(own.clone()));
        let s = status();
        assert!(s.installed);
        assert_eq!(s.kept.as_deref(), Some("echo mine"));

        let p = preview(false).unwrap();
        write(false, &p.fingerprint).unwrap();
        let removed: Value = serde_json::from_slice(&std::fs::read(&settings_file).unwrap()).unwrap();
        assert_eq!(removed, json!({ "theme": "dark", "statusLine": own }));
        assert_eq!(saved_previous(), None);
        assert!(!status().installed);
        assert_eq!(status().other.as_deref(), Some("echo mine"));
    }

    #[test]
    fn removing_never_touches_a_status_line_that_is_not_coucous() {
        let current = json!({ "statusLine": { "type": "command", "command": "starship statusline" } });
        let (next, saved) = next_settings(&current, false, None, CMD);
        assert_eq!(next, current);
        assert_eq!(saved, Saved::Untouched);
        let (next, _) = next_settings(&json!({}), false, None, CMD);
        assert_eq!(next, json!({}));
    }
}
