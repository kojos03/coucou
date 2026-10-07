// GitHub pulse and activity for the GitHub card (upstream #181, #185, #187):
// GitHubPulse.swift, GitHubActivity.swift and the GraphQL half of
// GithubPoller.swift. One query for your open pull requests (with the CI of
// their last commit and the review decision), the default-branch CI of your ten
// most recently pushed repositories, and the pull requests waiting for your
// review; another for your contribution calendar.
//
// It runs only while the GitHub pill is on, the token is set and Coucou is not
// paused, and talks to api.github.com only, with the token from the Credential
// Manager. Cadence as on macOS: the pulse 10 s after launch, then every minute
// while some CI runs and every five minutes otherwise; the calendar 15 s after
// launch, then every 30 minutes. Opening the card refreshes stale data.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::island::WINDOW_LABEL;
use crate::{log, secrets};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ci {
    Pending,
    Success,
    Failure,
    Unknown,
}

impl Ci {
    fn from_github(raw: Option<&str>) -> Ci {
        match raw.map(str::to_uppercase).as_deref() {
            Some("PENDING" | "EXPECTED") => Ci::Pending,
            Some("SUCCESS") => Ci::Success,
            Some("ERROR" | "FAILURE") => Ci::Failure,
            _ => Ci::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Review {
    Approved,
    ChangesRequested,
    Pending,
    Unknown,
}

impl Review {
    fn from_github(raw: Option<&str>) -> Review {
        match raw.map(str::to_uppercase).as_deref() {
            Some("APPROVED") => Review::Approved,
            Some("CHANGES_REQUESTED") => Review::ChangesRequested,
            Some("REVIEW_REQUIRED") => Review::Pending,
            _ => Review::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    /// "owner/repo#12"
    pub id: String,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub number: i64,
    pub is_draft: bool,
    pub ci: Ci,
    pub review: Review,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCi {
    pub repo: String,
    pub url: String,
    pub branch: String,
    pub ci: Ci,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pulse {
    pub login: String,
    pub my_prs: Vec<Pr>,
    pub to_review: Vec<Pr>,
    pub main_ci: Vec<RepoCi>,
    /// Unix seconds.
    pub fetched_at: u64,
}

impl Pulse {
    /// Some CI still runs: poll again in a minute rather than five.
    pub fn has_pending(&self) -> bool {
        self.my_prs.iter().any(|p| p.ci == Ci::Pending) || self.main_ci.iter().any(|r| r.ci == Ci::Pending)
    }
}

/// What changed between two pulses: drives the pill's badge and sound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    /// "ciFailed", "ciPassed", "mainFailed" or "reviewRequested".
    pub kind: &'static str,
    /// The pull request ("owner/repo#12") or the repository.
    pub id: String,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn nodes<'a>(v: Option<&'a Value>) -> &'a [Value] {
    v.and_then(|c| c.get("nodes")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// GitHubPulse.parse: duplicates and archived repositories are skipped.
pub fn parse_pulse(root: &Value) -> Option<Pulse> {
    let data = root.get("data")?.as_object()?;
    let viewer = data.get("viewer")?;
    let login = s(viewer, "login").unwrap_or_default().to_string();

    let mut seen = std::collections::HashSet::new();
    let mut my_prs = Vec::new();
    for node in nodes(viewer.get("pullRequests")) {
        let (Some(number), Some(title), Some(url), Some(repo)) = (
            node.get("number").and_then(Value::as_i64),
            s(node, "title"),
            s(node, "url"),
            node.get("repository").and_then(|r| s(r, "nameWithOwner")),
        ) else { continue };
        let id = format!("{repo}#{number}");
        if !seen.insert(id.clone()) {
            continue;
        }
        let commit = nodes(node.get("commits")).last().and_then(|c| c.get("commit"));
        let ci = commit.and_then(|c| c.get("statusCheckRollup")).and_then(|r| s(r, "state"));
        my_prs.push(Pr {
            id,
            title: title.into(),
            url: url.into(),
            repo: repo.into(),
            number,
            is_draft: node.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            ci: Ci::from_github(ci),
            review: Review::from_github(s(node, "reviewDecision")),
            head_sha: commit.and_then(|c| s(c, "oid")).map(String::from),
        });
    }

    let mut main_ci = Vec::new();
    for node in nodes(viewer.get("repositories")) {
        if node.get("isArchived").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let branch_ref = node.get("defaultBranchRef");
        let (Some(repo), Some(url), Some(branch)) =
            (s(node, "nameWithOwner"), s(node, "url"), branch_ref.and_then(|b| s(b, "name")))
        else { continue };
        let target = branch_ref.and_then(|b| b.get("target"));
        main_ci.push(RepoCi {
            repo: repo.into(),
            url: url.into(),
            branch: branch.into(),
            ci: Ci::from_github(target.and_then(|t| t.get("statusCheckRollup")).and_then(|r| s(r, "state"))),
            head_sha: target.and_then(|t| s(t, "oid")).map(String::from),
        });
    }

    let mut seen = std::collections::HashSet::new();
    let mut to_review = Vec::new();
    for node in nodes(data.get("reviewRequested")) {
        let (Some(number), Some(title), Some(url), Some(repo)) = (
            node.get("number").and_then(Value::as_i64),
            s(node, "title"),
            s(node, "url"),
            node.get("repository").and_then(|r| s(r, "nameWithOwner")),
        ) else { continue };
        let id = format!("{repo}#{number}");
        if !seen.insert(id.clone()) {
            continue;
        }
        to_review.push(Pr {
            id,
            title: title.into(),
            url: url.into(),
            repo: repo.into(),
            number,
            is_draft: node.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            ci: Ci::Unknown,
            review: Review::Pending,
            head_sha: None,
        });
    }

    Some(Pulse { login, my_prs, to_review, main_ci, fetched_at: now_secs() })
}

/// GitHubPulse.events. Nothing on the first poll after launch. With the same
/// head commit, the classic transitions; with a new commit (or a new pull
/// request), a CI that already finished alerts at once, so fast runs between
/// two polls are not missed. Default branches only ever alert on failure.
pub fn events(old: Option<&Pulse>, new: &Pulse) -> Vec<Event> {
    let Some(old) = old else { return Vec::new() };
    let mut out = Vec::new();
    let ev = |kind, id: &str| Event { kind, id: id.to_string() };

    for pr in &new.my_prs {
        match old.my_prs.iter().find(|p| p.id == pr.id) {
            Some(prev) if prev.head_sha == pr.head_sha => {
                if pr.ci == Ci::Failure && prev.ci != Ci::Failure {
                    out.push(ev("ciFailed", &pr.id));
                } else if pr.ci == Ci::Success && prev.ci == Ci::Pending {
                    out.push(ev("ciPassed", &pr.id));
                }
            }
            _ => match pr.ci {
                Ci::Success => out.push(ev("ciPassed", &pr.id)),
                Ci::Failure => out.push(ev("ciFailed", &pr.id)),
                _ => {}
            },
        }
    }
    for repo in &new.main_ci {
        match old.main_ci.iter().find(|r| r.repo == repo.repo) {
            Some(prev) if prev.head_sha == repo.head_sha => {
                if repo.ci == Ci::Failure && prev.ci != Ci::Failure {
                    out.push(ev("mainFailed", &repo.repo));
                }
            }
            _ => {
                if repo.ci == Ci::Failure {
                    out.push(ev("mainFailed", &repo.repo));
                }
            }
        }
    }
    for pr in &new.to_review {
        if !old.to_review.iter().any(|p| p.id == pr.id) {
            out.push(ev("reviewRequested", &pr.id));
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// YYYY-MM-DD
    pub date: String,
    pub count: i64,
    /// 0 (none) to 4 (fourth quartile)
    pub level: u8,
    /// 0 = Sunday … 6 = Saturday
    pub weekday: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub total: i64,
    pub weeks: Vec<Vec<Day>>,
    pub fetched_at: u64,
}

/// GitHubActivity.parse.
pub fn parse_activity(root: &Value) -> Option<Activity> {
    let cal = root.get("data")?.get("viewer")?.get("contributionsCollection")?.get("contributionCalendar")?;
    let total = cal.get("totalContributions")?.as_i64()?;
    let mut weeks = Vec::new();
    for week in cal.get("weeks")?.as_array()? {
        let Some(days) = week.get("contributionDays").and_then(Value::as_array) else { continue };
        let days: Vec<Day> = days
            .iter()
            .filter_map(|d| {
                Some(Day {
                    date: s(d, "date")?.to_string(),
                    count: d.get("contributionCount")?.as_i64()?,
                    level: match s(d, "contributionLevel")? {
                        "FIRST_QUARTILE" => 1,
                        "SECOND_QUARTILE" => 2,
                        "THIRD_QUARTILE" => 3,
                        "FOURTH_QUARTILE" => 4,
                        _ => 0,
                    },
                    weekday: u8::try_from(d.get("weekday")?.as_i64()?).ok()?,
                })
            })
            .collect();
        if !days.is_empty() {
            weeks.push(days);
        }
    }
    Some(Activity { total, weeks, fetched_at: now_secs() })
}

const PULSE_QUERY: &str = r#"query {
  viewer {
    login
    pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft reviewDecision
        repository { nameWithOwner url }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
    repositories(first: 10, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        nameWithOwner url isArchived
        defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { state } } } }
      }
    }
  }
  reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 20) {
    issueCount
    nodes { ... on PullRequest { number title url isDraft author { login } repository { nameWithOwner url } } }
  }
}"#;

const ACTIVITY_QUERY: &str = r#"query {
  viewer {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel weekday } }
      }
    }
  }
}"#;

static PULSE: Mutex<Option<Pulse>> = Mutex::new(None);
static ACTIVITY: Mutex<Option<Activity>> = Mutex::new(None);
static WAKE_PULSE: LazyLock<Notify> = LazyLock::new(Notify::new);
static WAKE_ACTIVITY: LazyLock<Notify> = LazyLock::new(Notify::new);
/// Bumped when the token changes, so an answer for the old token is dropped.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn wanted(app: &AppHandle) -> bool {
    if crate::integrations::PAUSED.load(Ordering::Relaxed) {
        return false;
    }
    app.try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().active_integrations.iter().any(|id| id == "integration_github"))
        .unwrap_or(false)
}

async fn query(token: &str, query: &str, what: &str) -> Option<Value> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "Coucou")
        .json(&json!({ "query": query }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        log::line(format!("github {what} HTTP {}", response.status().as_u16()));
        return None;
    }
    let root: Value = response.json().await.ok()?;
    // Partial GraphQL errors still come with data: keep it, note the count.
    if let Some(errors) = root.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
        log::line(format!("github {what} GraphQL errors: {}", errors.len()));
    }
    root.get("data").filter(|d| d.is_object())?;
    Some(root)
}

/// One pulse; returns whether some CI is still running.
async fn poll_pulse(app: &AppHandle) -> bool {
    let Some(token) = secrets::get("github-token") else { return false };
    let generation = GENERATION.load(Ordering::SeqCst);
    let Some(pulse) = query(&token, PULSE_QUERY, "pulse").await.as_ref().and_then(parse_pulse) else {
        return false;
    };
    if generation != GENERATION.load(Ordering::SeqCst) {
        return false;
    }
    let pending = pulse.has_pending();
    let events = {
        let mut last = PULSE.lock().unwrap();
        let events = events(last.as_ref(), &pulse);
        *last = Some(pulse.clone());
        events
    };
    let _ = app.emit_to(WINDOW_LABEL, "github-pulse", json!({ "pulse": pulse, "events": events }));
    pending
}

async fn poll_activity(app: &AppHandle) {
    let Some(token) = secrets::get("github-token") else { return };
    let generation = GENERATION.load(Ordering::SeqCst);
    let Some(activity) = query(&token, ACTIVITY_QUERY, "activity").await.as_ref().and_then(parse_activity) else {
        return;
    };
    if generation != GENERATION.load(Ordering::SeqCst) {
        return;
    }
    *ACTIVITY.lock().unwrap() = Some(activity.clone());
    let _ = app.emit_to(WINDOW_LABEL, "github-activity", activity);
}

pub fn start(app: AppHandle) {
    let pulse_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            let pending = if wanted(&pulse_app) { poll_pulse(&pulse_app).await } else { false };
            let wait = Duration::from_secs(if pending { 60 } else { 300 });
            let _ = tokio::time::timeout(wait, WAKE_PULSE.notified()).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if wanted(&app) {
                poll_activity(&app).await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(1800), WAKE_ACTIVITY.notified()).await;
        }
    });
}

fn stale(fetched_at: Option<u64>, max_age: u64) -> bool {
    fetched_at.is_none_or(|t| now_secs().saturating_sub(t) > max_age)
}

/// The card or one of its lists opened: fetch again if older than a minute
/// (the pulse) or five (the calendar), as refreshIfStale does.
pub fn refresh_if_stale(kind: &str) {
    match kind {
        "pulse" if stale(PULSE.lock().unwrap().as_ref().map(|p| p.fetched_at), 60) => WAKE_PULSE.notify_one(),
        "activity" if stale(ACTIVITY.lock().unwrap().as_ref().map(|a| a.fetched_at), 300) => WAKE_ACTIVITY.notify_one(),
        _ => {}
    }
}

/// Refresh now (the card's Refresh).
pub fn refresh_now() {
    WAKE_PULSE.notify_one();
    WAKE_ACTIVITY.notify_one();
}

/// A new token: forget what the old one saw (so its first poll alerts no one),
/// drop answers still in flight, and fetch at once (triggerPulseNow).
pub fn token_changed(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *PULSE.lock().unwrap() = None;
    *ACTIVITY.lock().unwrap() = None;
    let _ = app.emit_to(WINDOW_LABEL, "github-pulse", json!({ "pulse": null, "events": [] }));
    let _ = app.emit_to(WINDOW_LABEL, "github-activity", Value::Null);
    refresh_now();
}

pub fn latest() -> Value {
    json!({ "pulse": *PULSE.lock().unwrap(), "activity": *ACTIVITY.lock().unwrap() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(id: &str, ci: Ci, sha: Option<&str>) -> Pr {
        let (repo, number) = id.split_once('#').unwrap();
        Pr {
            id: id.into(), title: "t".into(), url: format!("https://github.com/{repo}/pull/{number}"),
            repo: repo.into(), number: number.parse().unwrap(), is_draft: false, ci,
            review: Review::Unknown, head_sha: sha.map(String::from),
        }
    }
    fn repo(name: &str, ci: Ci, sha: Option<&str>) -> RepoCi {
        RepoCi { repo: name.into(), url: format!("https://github.com/{name}"), branch: "main".into(), ci, head_sha: sha.map(String::from) }
    }
    fn pulse(my: Vec<Pr>, review: Vec<Pr>, main: Vec<RepoCi>) -> Pulse {
        Pulse { login: "me".into(), my_prs: my, to_review: review, main_ci: main, fetched_at: 0 }
    }
    fn kinds(e: Vec<Event>) -> Vec<(String, String)> {
        e.into_iter().map(|e| (e.kind.to_string(), e.id)).collect()
    }

    #[test]
    fn parses_the_pulse_like_the_mac() {
        let root = json!({ "data": {
            "viewer": {
                "login": "kojos03",
                "pullRequests": { "nodes": [
                    { "number": 7, "title": "Add wardrobe", "url": "https://github.com/a/b/pull/7", "isDraft": true,
                      "reviewDecision": "CHANGES_REQUESTED", "repository": { "nameWithOwner": "a/b" },
                      "commits": { "nodes": [{ "commit": { "oid": "abc", "statusCheckRollup": { "state": "FAILURE" } } }] } },
                    { "number": 7, "title": "dup", "url": "u", "repository": { "nameWithOwner": "a/b" } },
                    { "number": 8, "title": "No CI", "url": "u8", "repository": { "nameWithOwner": "a/b" }, "commits": { "nodes": [] } },
                    { "title": "broken" }
                ] },
                "repositories": { "nodes": [
                    { "nameWithOwner": "a/b", "url": "https://github.com/a/b", "isArchived": false,
                      "defaultBranchRef": { "name": "main", "target": { "oid": "m1", "statusCheckRollup": { "state": "EXPECTED" } } } },
                    { "nameWithOwner": "a/old", "url": "x", "isArchived": true, "defaultBranchRef": { "name": "main" } },
                    { "nameWithOwner": "a/empty", "url": "y", "defaultBranchRef": null }
                ] }
            },
            "reviewRequested": { "nodes": [
                { "number": 3, "title": "Please look", "url": "https://github.com/c/d/pull/3", "repository": { "nameWithOwner": "c/d" } },
                { "number": 3, "title": "dup", "url": "u", "repository": { "nameWithOwner": "c/d" } },
                {}
            ] }
        }});
        let p = parse_pulse(&root).unwrap();
        assert_eq!(p.login, "kojos03");
        assert_eq!(p.my_prs.len(), 2);
        let first = &p.my_prs[0];
        assert_eq!((first.id.as_str(), first.ci, first.review, first.is_draft), ("a/b#7", Ci::Failure, Review::ChangesRequested, true));
        assert_eq!(first.head_sha.as_deref(), Some("abc"));
        assert_eq!((p.my_prs[1].ci, p.my_prs[1].head_sha.clone()), (Ci::Unknown, None));
        assert_eq!(p.main_ci.len(), 1, "archived and branchless repos are skipped");
        assert_eq!((p.main_ci[0].ci, p.main_ci[0].branch.as_str()), (Ci::Pending, "main"));
        assert!(p.has_pending());
        assert_eq!(p.to_review.len(), 1);
        assert_eq!((p.to_review[0].id.as_str(), p.to_review[0].review), ("c/d#3", Review::Pending));
        assert!(parse_pulse(&json!({ "errors": [{}] })).is_none());
        assert!(parse_pulse(&json!({ "data": null })).is_none());
    }

    #[test]
    fn events_follow_the_head_commit() {
        // First poll after launch: silence.
        let now = pulse(vec![pr("a/b#1", Ci::Failure, Some("x"))], vec![pr("c/d#2", Ci::Unknown, None)], vec![]);
        assert!(events(None, &now).is_empty());

        // Same commit: pending → success passes, anything → failure fails, success → success is quiet.
        let old = pulse(vec![pr("a/b#1", Ci::Pending, Some("x")), pr("a/b#2", Ci::Success, Some("y"))], vec![], vec![]);
        let new = pulse(vec![pr("a/b#1", Ci::Success, Some("x")), pr("a/b#2", Ci::Failure, Some("y"))], vec![], vec![]);
        assert_eq!(kinds(events(Some(&old), &new)), vec![
            ("ciPassed".into(), "a/b#1".into()), ("ciFailed".into(), "a/b#2".into()),
        ]);
        assert!(events(Some(&new), &new).is_empty(), "nothing twice");

        // A new commit whose fast CI already finished between polls still alerts.
        let pushed = pulse(vec![pr("a/b#1", Ci::Success, Some("z")), pr("a/b#2", Ci::Pending, Some("w"))], vec![], vec![]);
        assert_eq!(kinds(events(Some(&new), &pushed)), vec![("ciPassed".into(), "a/b#1".into())]);
        // A brand new pull request too.
        let opened = pulse(vec![pr("a/b#9", Ci::Failure, Some("q"))], vec![], vec![]);
        assert_eq!(kinds(events(Some(&old), &opened)), vec![("ciFailed".into(), "a/b#9".into())]);

        // Default branches: failure only, never "green".
        let m_old = pulse(vec![], vec![], vec![repo("a/b", Ci::Pending, Some("1")), repo("a/c", Ci::Failure, Some("2"))]);
        let m_new = pulse(vec![], vec![], vec![repo("a/b", Ci::Failure, Some("1")), repo("a/c", Ci::Failure, Some("2")), repo("a/d", Ci::Success, Some("3"))]);
        assert_eq!(kinds(events(Some(&m_old), &m_new)), vec![("mainFailed".into(), "a/b".into())]);
        let m_pushed = pulse(vec![], vec![], vec![repo("a/c", Ci::Failure, Some("9"))]);
        assert_eq!(kinds(events(Some(&m_old), &m_pushed)), vec![("mainFailed".into(), "a/c".into())]);

        // Review requests: only the new ones.
        let r_old = pulse(vec![], vec![pr("c/d#2", Ci::Unknown, None)], vec![]);
        let r_new = pulse(vec![], vec![pr("c/d#2", Ci::Unknown, None), pr("c/d#5", Ci::Unknown, None)], vec![]);
        assert_eq!(kinds(events(Some(&r_old), &r_new)), vec![("reviewRequested".into(), "c/d#5".into())]);
    }

    #[test]
    fn parses_the_contribution_calendar() {
        let root = json!({ "data": { "viewer": { "contributionsCollection": { "contributionCalendar": {
            "totalContributions": 1234,
            "weeks": [
                { "contributionDays": [
                    { "date": "2026-10-04", "contributionCount": 0, "contributionLevel": "NONE", "weekday": 0 },
                    { "date": "2026-10-05", "contributionCount": 9, "contributionLevel": "FOURTH_QUARTILE", "weekday": 1 },
                    { "date": "2026-10-06", "contributionCount": 2, "contributionLevel": "FIRST_QUARTILE", "weekday": 2 },
                    { "date": "bad" }
                ] },
                { "contributionDays": [] }
            ]
        }}}}});
        let a = parse_activity(&root).unwrap();
        assert_eq!(a.total, 1234);
        assert_eq!(a.weeks.len(), 1, "empty weeks are dropped");
        assert_eq!(a.weeks[0].iter().map(|d| d.level).collect::<Vec<_>>(), vec![0, 4, 1]);
        assert_eq!(a.weeks[0][1].weekday, 1);
        assert!(parse_activity(&json!({ "data": {} })).is_none());
    }

    #[test]
    fn staleness() {
        assert!(stale(None, 60));
        assert!(!stale(Some(now_secs()), 60));
        assert!(stale(Some(now_secs() - 61), 60));
    }
}
