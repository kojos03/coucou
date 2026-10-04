// Who answers a Codex session's approvals.
//
// Codex resolves an approval in this order: PermissionRequest hooks first, then
// whoever `approvals_reviewer` names — "user" (a prompt in the chat) or
// "auto_review" (Codex's own reviewer agent, the desktop app's default). Our
// hook runs in front of both, so without this check the island would ask the
// person about requests Codex itself was going to settle without them, and
// hold Codex until they clicked.
//
// The hook payload does not carry the reviewer, but it does name the session's
// transcript (coucou-hook forwards that path for Codex approvals only), and
// every turn starts with a `turn_context` record that does. We read only that
// one field, locally, keep nothing, and the island never sees the path.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

/// Enough of the transcript's end to hold the current turn's opening record.
const TAIL: u64 = 32 * 1024 * 1024;

/// True when this Codex PermissionRequest will be settled by Codex's reviewer
/// agent rather than a person. Unknown means false: the island asks, as before.
pub fn auto_reviewed(payload: &Value) -> bool {
    let Some(path) = payload.get("transcript_path").and_then(Value::as_str) else {
        return false;
    };
    let turn = payload.get("turn_id").and_then(Value::as_str);
    reviewer_in(Path::new(path), turn).is_some_and(|reviewer| reviewer != "user")
}

fn reviewer_in(path: &Path, turn: Option<&str>) -> Option<String> {
    if path.extension()? != "jsonl" {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    latest_reviewer(&String::from_utf8_lossy(&bytes), turn)
}

/// The reviewer named by this turn's `turn_context`, or failing that the most
/// recent one (the setting carries over between turns). A record without the
/// field predates reviewers, when every approval went to the user.
fn latest_reviewer(transcript: &str, turn: Option<&str>) -> Option<String> {
    let mut latest = None;
    for line in transcript.lines().rev() {
        if !line.contains("\"turn_context\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        if record.get("type").and_then(Value::as_str) != Some("turn_context") {
            continue;
        }
        let context = record.get("payload").unwrap_or(&Value::Null);
        let reviewer = context
            .get("approvals_reviewer")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        let same_turn = turn.is_some() && context.get("turn_id").and_then(Value::as_str) == turn;
        if same_turn || turn.is_none() {
            return Some(reviewer);
        }
        latest.get_or_insert(reviewer);
    }
    latest
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context(turn: &str, reviewer: Option<&str>) -> String {
        let mut payload = json!({ "turn_id": turn, "approval_policy": "on-request" });
        if let Some(r) = reviewer {
            payload["approvals_reviewer"] = json!(r);
        }
        json!({ "timestamp": "2026-10-04T10:53:32Z", "type": "turn_context", "payload": payload }).to_string()
    }

    fn item(text: &str) -> String {
        json!({ "type": "response_item", "payload": { "type": "message", "content": text } }).to_string()
    }

    #[test]
    fn the_current_turn_decides_and_an_older_one_fills_in() {
        let transcript = [
            context("t1", Some("user")),
            item("a message that mentions \"turn_context\" in passing"),
            context("t2", Some("auto_review")),
            item("work"),
        ]
        .join("\n");
        assert_eq!(latest_reviewer(&transcript, Some("t2")).as_deref(), Some("auto_review"));
        assert_eq!(latest_reviewer(&transcript, Some("t1")).as_deref(), Some("user"));
        // This turn's record is not on disk yet: the latest setting stands.
        assert_eq!(latest_reviewer(&transcript, Some("t3")).as_deref(), Some("auto_review"));
        assert_eq!(latest_reviewer(&transcript, None).as_deref(), Some("auto_review"));
        // Older transcripts have no reviewer, and no context at all says nothing.
        assert_eq!(latest_reviewer(&context("t1", None), Some("t1")).as_deref(), Some("user"));
        assert_eq!(latest_reviewer(&item("hello"), Some("t1")), None);
    }

    #[test]
    fn only_a_readable_session_transcript_with_a_reviewer_skips_the_island() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-codex-review-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        let auto = dir.join("rollout-auto.jsonl");
        std::fs::write(&auto, [context("t1", Some("auto_review")), item("x")].join("\n") + "\n").unwrap();
        let user = dir.join("rollout-user.jsonl");
        std::fs::write(&user, context("t1", Some("user")) + "\n").unwrap();
        let other = dir.join("notes.txt");
        std::fs::write(&other, context("t1", Some("auto_review"))).unwrap();

        let ask = |path: &Path| json!({ "transcript_path": path, "turn_id": "t1" });
        assert!(auto_reviewed(&ask(&auto)));
        assert!(!auto_reviewed(&ask(&user)));
        assert!(!auto_reviewed(&ask(&other)));
        assert!(!auto_reviewed(&ask(&dir.join("missing.jsonl"))));
        assert!(!auto_reviewed(&json!({ "turn_id": "t1" })));
        assert!(!auto_reviewed(&json!({ "transcript_path": null })));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
