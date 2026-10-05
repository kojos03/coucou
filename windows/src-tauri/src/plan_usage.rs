// Plan usage: the 5-hour and weekly windows of the Claude and ChatGPT plans,
// for the usage lines on the Claude Code and Codex cards. A port of upstream
// #159, extended.
//
// Claude's numbers are one pool for Claude Code, Cowork and the Claude apps.
// They come, freshest first, from Claude Code's status line (relayed by
// `coucou-hook --statusline` after each terminal reply), from Claude's Mochi's
// own chats, and otherwise from a tiny check through Claude Code (claude_cli.rs)
// when the card shows numbers more than ten minutes old. Codex's come from
// Codex itself (`codex app-server`, no model call), or its session logs.
//
// The gauges are validated, kept in memory and in plan-usage.json /
// codex-usage.json so they survive a restart, and sent to the island. The
// status line installer: the
// `statusLine` key of ~/.claude/settings.json, under the hooks' rules (diff,
// dated backup, written only after an explicit click). A status line the user
// already had keeps running: it is saved beside the relay, which runs it and
// prints what it prints, and removing Coucou's puts it back exactly.
//
// This is Claude Code's own data about the plan; Coucou never touches the
// Claude sign-in for it.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// The plan is refusing requests until a window resets.
    #[serde(default)]
    pub limit_reached: bool,
}

static LATEST: Mutex<Option<PlanUsage>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();
static CLAUDE_CHECKED: Mutex<Option<Instant>> = Mutex::new(None);
static CODEX_CHECKED: Mutex<Option<Instant>> = Mutex::new(None);
/// How old Claude's numbers may get before the card asks Claude Code again.
const CLAUDE_EVERY: Duration = Duration::from_secs(10 * 60);
/// How often the card may ask Codex.
const CODEX_EVERY: Duration = Duration::from_secs(60);
/// The shortest gap between two checks that a click or a finished turn asks for.
const FORCED_EVERY: Duration = Duration::from_secs(20);

/// Lets the readers that run outside a command (Mochi's chats, the relay,
/// finished Codex turns) reach the island.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn show(event: &str, usage: &PlanUsage) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to(WINDOW_LABEL, event, usage.clone());
    }
}

/// True when the last check was too recent; otherwise marks a check as begun.
fn too_soon(last: &Mutex<Option<Instant>>, every: Duration) -> bool {
    let mut last = last.lock().unwrap();
    if last.is_some_and(|at| at.elapsed() < every) {
        return true;
    }
    *last = Some(Instant::now());
    false
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The windows in a relayed status line payload, or None when it has none we
/// can trust (a Free plan, the session's first reply, malformed numbers).
pub fn parse(payload: &Value, now: u64) -> Option<PlanUsage> {
    let limits = payload.get("rate_limits")?;
    let five_hour = window(limits.get("five_hour"), now);
    let seven_day = window(limits.get("seven_day"), now);
    (five_hour.is_some() || seven_day.is_some())
        .then_some(PlanUsage { five_hour, seven_day, updated_at: now, limit_reached: false })
}

/// Claude Code's `rate_limit_info` (stream-json): `unifiedWindows` holds both
/// windows, with `utilization` from 0 to 1 (above 1 past the limit) and
/// `resetsAt` in seconds; without it, only the window named by `rateLimitType`.
pub fn parse_claude_info(info: &Value, now: u64) -> Option<PlanUsage> {
    let window_of = |raw: &Value| -> Option<PlanWindow> {
        let utilization = raw.get("utilization")?.as_f64()?;
        let mut resets = raw.get("resetsAt")?.as_f64()?;
        if resets > 1e11 {
            resets /= 1000.0; // milliseconds
        }
        checked(utilization * 100.0, resets, now)
    };
    let windows = info.get("unifiedWindows");
    let mut five_hour = windows.and_then(|w| w.get("five_hour")).and_then(window_of);
    let mut seven_day = windows.and_then(|w| w.get("seven_day")).and_then(window_of);
    if five_hour.is_none() && seven_day.is_none() {
        match info.get("rateLimitType").and_then(Value::as_str) {
            Some("five_hour") => five_hour = window_of(info),
            Some("seven_day") => seven_day = window_of(info),
            _ => {}
        }
    }
    let limit_reached = info.get("status").and_then(Value::as_str) == Some("rejected");
    (five_hour.is_some() || seven_day.is_some())
        .then_some(PlanUsage { five_hour, seven_day, updated_at: now, limit_reached })
}

fn window(raw: Option<&Value>, now: u64) -> Option<PlanWindow> {
    let raw = raw?;
    checked(raw.get("used_percentage")?.as_f64()?, raw.get("resets_at")?.as_f64()?, now)
}

/// One window, if its numbers make sense: a percentage (slightly over 100
/// happens at the limit; far over is nonsense) and a reset time in seconds.
fn checked(pct: f64, resets: f64, now: u64) -> Option<PlanWindow> {
    if !(0.0..=200.0).contains(&pct) {
        return None;
    }
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

fn store_claude(usage: PlanUsage) {
    *LATEST.lock().unwrap() = Some(usage.clone());
    if let Ok(text) = serde_json::to_vec(&usage) {
        let _ = std::fs::write(usage_path(), text);
    }
    show("plan-usage", &usage);
}

/// A status line payload from the relay: keep and show what it says.
pub fn record(payload: &Value) {
    if let Some(usage) = parse(payload, now()) {
        store_claude(usage);
    }
}

/// A `rate_limit_info` from one of Claude Code's runs.
pub fn record_claude_info(info: &Value) {
    if let Some(usage) = parse_claude_info(info, now()) {
        store_claude(usage);
    }
}

/// Asks Claude Code for the plan's numbers, when the card's are more than ten
/// minutes old (`force`, a click on Refresh: twenty seconds). Blocking: a few
/// seconds.
pub fn refresh_claude(force: bool) {
    let every = if force { FORCED_EVERY } else { CLAUDE_EVERY };
    if latest().is_some_and(|usage| now().saturating_sub(usage.updated_at) < every.as_secs()) {
        return;
    }
    if too_soon(&CLAUDE_CHECKED, every) {
        return;
    }
    if let Some(info) = crate::claude_cli::plan_check() {
        record_claude_info(&info);
    }
}

// ── Codex ────────────────────────────────────────────────────────────────────
//
// Codex answers `account/rateLimits/read` itself (`codex app-server`, the
// read the Codex app makes for its usage view): live numbers, including a
// reached limit. Failing that, every reply in a session log
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) carries a `token_count`
// event with the same `rate_limits` — but a refused turn writes none, which
// is why the logs alone kept showing the numbers from before the limit.

static CODEX_LATEST: Mutex<Option<PlanUsage>> = Mutex::new(None);
/// How much of a session log's end is searched for its last reading.
const LOG_TAIL: u64 = 4 * 1024 * 1024;
/// Day folders searched for the chat that just finished.
const DAYS_BACK: usize = 14;

fn codex_usage_path() -> PathBuf {
    settings::local_dir().join("codex-usage.json")
}

/// The latest Codex numbers, from memory or from the last run.
pub fn codex_latest() -> Option<PlanUsage> {
    let mut latest = CODEX_LATEST.lock().unwrap();
    if latest.is_none() {
        *latest = std::fs::read(codex_usage_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PlanUsage>(&bytes).ok());
    }
    latest.clone()
}

/// Looks for newer numbers — at launch, after each Codex turn, and when the
/// card is shown — and shows them. Live from Codex at most once a minute
/// (`force`: every twenty seconds), else from the logs. `session` is the chat
/// that just finished, whose log may be days old. Blocking: about a second.
pub fn refresh_codex(session: Option<&str>, force: bool) {
    let now = now();
    let live = (!too_soon(&CODEX_CHECKED, if force { FORCED_EVERY } else { CODEX_EVERY }))
        .then(crate::codex_cli::rate_limits)
        .flatten()
        .and_then(|limits| parse_codex(&limits, now, now));
    let found = live.or_else(|| {
        let dir = crate::codex_hooks::hooks_path().with_file_name("sessions");
        newest_codex_reading(&dir, session, now)
    });
    let Some(found) = found else { return };
    if codex_latest().is_some_and(|current| current.updated_at >= found.updated_at) {
        return;
    }
    *CODEX_LATEST.lock().unwrap() = Some(found.clone());
    if let Ok(text) = serde_json::to_vec(&found) {
        let _ = std::fs::write(codex_usage_path(), text);
    }
    show("codex-usage", &found);
}

fn newest_codex_reading(dir: &Path, session: Option<&str>, now: u64) -> Option<PlanUsage> {
    codex_logs(dir, session)
        .iter()
        .filter_map(|log| reading_in(log, now))
        .max_by_key(|usage| usage.updated_at)
}

/// Sub-folders by name, newest first (the session tree is year/month/day).
fn newest_first(dir: &Path, files: bool) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.filter_map(Result::ok).map(|e| e.path()).filter(|p| if files { p.is_file() } else { p.is_dir() }).collect())
        .unwrap_or_default();
    entries.sort();
    entries.reverse();
    entries
}

/// The newest logs of the last two days (a log's name starts with its creation
/// time), and the finished chat's own log wherever it is.
fn codex_logs(dir: &Path, session: Option<&str>) -> Vec<PathBuf> {
    let mut days = Vec::new();
    'outer: for year in newest_first(dir, false) {
        for month in newest_first(&year, false) {
            for day in newest_first(&month, false) {
                days.push(day);
                if days.len() >= DAYS_BACK {
                    break 'outer;
                }
            }
        }
    }
    let is_log = |p: &PathBuf| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
    };
    let mut logs: Vec<PathBuf> = days
        .iter()
        .take(2)
        .flat_map(|day| newest_first(day, true).into_iter().filter(is_log).take(6))
        .collect();
    if let Some(id) = session.filter(|id| !id.is_empty()) {
        let suffix = format!("-{id}.jsonl");
        let own = days.iter().find_map(|day| {
            newest_first(day, true)
                .into_iter()
                .find(|p| is_log(p) && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
        });
        logs.extend(own);
    }
    logs.sort();
    logs.dedup();
    logs
}

/// The last plan reading in one session log.
fn reading_in(path: &Path, now: u64) -> Option<PlanUsage> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    text.lines().rev().filter(|line| line.contains("\"rate_limits\"")).find_map(|line| {
        let record = serde_json::from_str::<Value>(line).ok()?;
        let limits = record.get("payload")?.get("rate_limits")?;
        let at = record.get("timestamp").and_then(Value::as_str).and_then(utc_seconds).unwrap_or(0);
        parse_codex(limits, at, now)
    })
}

/// Codex's `rate_limits`, as the logs write them (`used_percent`,
/// `window_minutes`, `resets_at`) or as the app server answers them
/// (`usedPercent`, `windowDurationMins`, `resetsAt`). Each window goes by its
/// length, so a plan whose primary window is the week still reads right.
pub fn parse_codex(limits: &Value, at: u64, now: u64) -> Option<PlanUsage> {
    let num = |raw: &Value, names: [&str; 2]| names.iter().find_map(|name| raw.get(*name).and_then(Value::as_f64));
    let mut five_hour = None;
    let mut seven_day = None;
    for key in ["primary", "secondary"] {
        let Some(raw) = limits.get(key).filter(|v| v.is_object()) else { continue };
        let Some(w) = num(raw, ["used_percent", "usedPercent"])
            .zip(num(raw, ["resets_at", "resetsAt"]))
            .and_then(|(pct, resets)| checked(pct, resets, now))
        else {
            continue;
        };
        let weekly = match num(raw, ["window_minutes", "windowDurationMins"]) {
            Some(minutes) => minutes >= 24.0 * 60.0,
            None => key == "secondary",
        };
        if weekly { seven_day.get_or_insert(w) } else { five_hour.get_or_insert(w) };
    }
    let limit_reached = ["rate_limit_reached_type", "rateLimitReachedType"]
        .iter()
        .any(|name| limits.get(*name).is_some_and(|v| !v.is_null()));
    (five_hour.is_some() || seven_day.is_some())
        .then_some(PlanUsage { five_hour, seven_day, updated_at: at, limit_reached })
}

/// `2026-10-04T14:26:44.459Z` as Unix seconds (UTC only, as Codex writes it).
fn utc_seconds(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || !text.ends_with('Z') {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from 1970-01-01 to the date, in the proleptic Gregorian calendar.
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
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
    fn claude_codes_rate_limit_event_gives_both_windows() {
        let info = json!({ "status": "allowed_warning", "resetsAt": NOW + 86_400, "rateLimitType": "seven_day",
            "utilization": 0.56, "isUsingOverage": false, "unifiedWindows": {
                "five_hour": { "utilization": 0.24, "resetsAt": NOW + 3600 },
                "seven_day": { "utilization": 0.56, "resetsAt": NOW + 86_400 } } });
        let usage = parse_claude_info(&info, NOW).unwrap();
        assert_eq!(usage.five_hour, Some(PlanWindow { used_pct: 24.0, resets_at: NOW + 3600 }));
        assert!((usage.seven_day.unwrap().used_pct - 56.0).abs() < 1e-9);
        assert!(!usage.limit_reached);
        // At the limit: refused, slightly over 100 %, reset times in milliseconds.
        let refused = json!({ "status": "rejected", "rateLimitType": "five_hour", "utilization": 1.04,
            "resetsAt": (NOW + 600) * 1000 });
        let usage = parse_claude_info(&refused, NOW).unwrap();
        assert_eq!(usage.five_hour, Some(PlanWindow { used_pct: 100.0, resets_at: NOW + 600 }));
        assert_eq!(usage.seven_day, None);
        assert!(usage.limit_reached);
        assert_eq!(parse_claude_info(&json!({ "status": "allowed" }), NOW), None);
    }

    #[test]
    fn codexs_own_answer_is_read_like_its_logs_and_says_when_the_limit_is_reached() {
        // `account/rateLimits/read`, as Codex 0.160 answered it at the limit.
        let live = json!({ "limitId": "codex", "primary": { "usedPercent": 13, "windowDurationMins": 300, "resetsAt": NOW + 3000 },
            "secondary": { "usedPercent": 100, "windowDurationMins": 10080, "resetsAt": NOW + 86_400 },
            "planType": "plus", "rateLimitReachedType": "rate_limit_reached" });
        let usage = parse_codex(&live, NOW, NOW).unwrap();
        assert_eq!(usage.five_hour.unwrap().used_pct, 13.0);
        assert_eq!(usage.seven_day.unwrap().used_pct, 100.0);
        assert!(usage.limit_reached);
        let fine = json!({ "primary": { "usedPercent": 13, "windowDurationMins": 300, "resetsAt": NOW + 3000 },
            "rateLimitReachedType": null });
        assert!(!parse_codex(&fine, NOW, NOW).unwrap().limit_reached);
    }

    #[test]
    fn codex_logs_give_their_last_plan_reading() {
        let limits = json!({
            "limit_id": "codex",
            "primary": { "used_percent": 83.0, "window_minutes": 300, "resets_at": NOW + 3600 },
            "secondary": { "used_percent": 92.0, "window_minutes": 10080, "resets_at": NOW + 86_400 },
            "plan_type": "plus",
        });
        let usage = parse_codex(&limits, NOW - 5, NOW).unwrap();
        assert_eq!(usage.five_hour.unwrap().used_pct, 83.0);
        assert_eq!(usage.seven_day.unwrap().used_pct, 92.0);
        assert_eq!(usage.updated_at, NOW - 5);
        // Windows go by their length, not their slot.
        let swapped = json!({ "primary": { "used_percent": 10, "window_minutes": 10080, "resets_at": NOW + 9 } });
        let usage = parse_codex(&swapped, NOW, NOW).unwrap();
        assert_eq!((usage.five_hour, usage.seven_day.map(|w| w.used_pct)), (None, Some(10.0)));
        assert_eq!(parse_codex(&json!({ "primary": null, "secondary": null }), NOW, NOW), None);

        assert_eq!(utc_seconds("2026-10-04T14:26:44.459Z"), Some(1_791_124_004));
        assert_eq!(utc_seconds("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(utc_seconds("2024-02-29T23:59:59Z"), Some(1_709_251_199));
        assert_eq!(utc_seconds("2026-10-04 14:26:44"), None);

        // The newest reading across logs wins; the finished chat's older log is
        // searched too, and lines that are not readings are skipped.
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("coucou-codex-usage-{unique}"));
        let line = |ts: &str, pct: f64| json!({ "timestamp": ts, "type": "event_msg", "payload": { "type": "token_count",
            "rate_limits": { "primary": { "used_percent": pct, "window_minutes": 300, "resets_at": NOW + 60 } } } }).to_string();
        let write = |day: &str, name: &str, lines: &[String]| {
            let dir = root.join(day);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(name), lines.join("\n") + "\n").unwrap();
        };
        write("2026/10/04", "rollout-2026-10-04T10-00-00-aaa.jsonl", &[line("2026-10-04T10:00:00Z", 40.0), line("2026-10-04T10:05:00Z", 45.0)]);
        write("2026/10/04", "rollout-2026-10-04T12-00-00-bbb.jsonl", &[line("2026-10-04T12:00:00Z", 50.0), r#"{"type":"event_msg","payload":{"text":"\"rate_limits\" said"}}"#.to_string()]);
        write("2026/10/03", "rollout-2026-10-03T10-00-00-ccc.jsonl", &[line("2026-10-03T10:00:00Z", 30.0)]);
        // Three days back: only searched as the finished chat's own log.
        write("2026/09/20", "rollout-2026-09-20T09-00-00-old.jsonl", &[line("2026-10-04T13:00:00Z", 77.0)]);
        let found = newest_codex_reading(&root, None, NOW).unwrap();
        assert_eq!(found.five_hour.unwrap().used_pct, 50.0);
        let found = newest_codex_reading(&root, Some("old"), NOW).unwrap();
        assert_eq!(found.five_hour.unwrap().used_pct, 77.0);
        assert_eq!(newest_codex_reading(&root.join("missing"), None, NOW), None);
        let _ = std::fs::remove_dir_all(&root);
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
