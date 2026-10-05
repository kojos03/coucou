# Windows Codex integration: progress and next phases

Last updated: 3 October 2026.

This is the engineering handoff for Konstantinos and Zack on the
[kojos03/coucou fork](https://github.com/kojos03/coucou/tree/windows-codex).
The implementation baseline is
[ee6176f — Fix Windows Codex activity and completion lifecycle](https://github.com/kojos03/coucou/commit/ee6176f7c42103de18d298d3a90969097204665f)
on `windows-codex`. Select that branch when building or reviewing the Windows
work; the fork's `main` branch is a separate line of development.

**Current status:** Codex activity and completion work in the tested Windows
setup. This is still a development build: setup, terminal navigation, chat
onboarding, Codex approvals, and installer validation need further work.
The phases below are proposed work, not implemented features.

## What has been completed

### 1. Diagnosed and repaired missing Stop delivery

In the tested Codex 0.160 setup, Windows hooks ran through PowerShell. The
`commandWindows` values in the local `%USERPROFILE%\.codex\hooks.json` began with
a quoted executable path but omitted PowerShell's call operator, `&`. PowerShell
reported a parser error before launching the relay, so Coucou never received
the `Stop` event and could not show the finished card.

All eight configured Windows commands were corrected after a dated backup.
The events were `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`SubagentStart`, `SubagentStop`, `Stop`, and `SessionEnd`. The fallback `command`
values were preserved. The investigation confirmed that the hooks were enabled
and trusted; it did not require a change to `config.toml`.

Example PowerShell command, with the local user path substituted:

```powershell
& "C:\Users\<user>\AppData\Local\Coucou\bin\coucou-hook.exe" --agent codex Stop
```

This is shell syntax, not a complete JSON configuration. The personal hook
configuration and its backup stay outside Git. This machine-specific repair is
not automatically installed by cloning the fork.

The existing relay and named-pipe transport already delivered correctly formed
events. The `pipe.rs` change in the baseline commit is formatting only.

### 2. Fixed completion content and repeated-turn behavior

- Codex `Stop` uses `last_assistant_message`, then `message`, then a generic
  completion message. Displayed steps retain the existing 60-character limit.
- The finished card uses the agent's name, so Codex displays **Codex finished**.
- Codex has a persistent pill and is the initial focus in this fork.
- A new prompt clears the previous turn's steps and completion badge. If the
  expanded island is showing an old result, it returns to the activity overview.
  Deliberately opened Settings/chat views are preserved.
- Completion while another pill is focused adds a badge without taking focus.

### 3. Added session and turn tracking

Several Codex chats share one pill. The tracker selects the most recently
started active turn; completed chats cannot displace another active chat.
Once no turn is active, the most recent remaining result is selected.

Events use `session_id` and `turn_id` to reject mismatched completions and known
retired turns. Late tool events cannot resurrect a completed turn, and duplicate
completion events do not replay the finish sound. Closing a completed chat
preserves another chat's activity.

Limits are explicit: `SessionEnd` closes the named session without turn-level
matching; `SessionStart` is informational and does not start activity. Missing
identifiers cannot provide full ordering guarantees. Legacy unidentified
payloads work alone, but cannot overwrite identified chats. Tracking is held in
memory, and lost events, crashes, and previously unseen out-of-order prompts
still need hardening.

### 4. Published the source snapshot

The `windows-codex` branch contains the full tracked project, including the
existing macOS source and documentation. The baseline commit preserves the
local Windows changes and adds the session tracker and regression suite.
It adds no new dependencies. Build outputs, credentials, and personal Codex
configuration are not part of the source snapshot.

## Where the implementation lives

| File | Responsibility |
|---|---|
| [hooks.ts](../windows/src/island/hooks.ts) | Receives events and updates the island, badges, completion text, and sounds |
| [codex-sessions.ts](../windows/src/island/codex-sessions.ts) | Correlates sessions/turns and selects the activity shown by the shared Codex pill |
| [state.ts](../windows/src/core/state.ts) | Persistent pill, default focus, and task state |
| [views.ts](../windows/src/views/views.ts) | Activity ticker and agent-specific finished-card label |
| [pipe.rs](../windows/src-tauri/src/pipe.rs) and [relay](../windows/hook/src/main.rs) | Native transport and hook forwarding |
| [hooks.test.mjs](../windows/tests/hooks.test.mjs) | 15 lifecycle regression tests |
| [island.ts](../windows/src/island/island.ts) and [lib.rs](../windows/src-tauri/src/lib.rs) | Current terminal-button routing and VS Code launcher |
| [claude.rs](../windows/src-tauri/src/claude.rs) and [secrets.rs](../windows/src-tauri/src/secrets.rs) | Mochi chat API calls and credential access |
| [settings](../windows/src/settings/main.ts) and [hook installer](../windows/src-tauri/src/hooks.rs) | Existing Windows settings and Claude Code hook installation |

## What was verified

The implementation was checked on Windows on 2 October 2026. The 15 regression
tests were run again on 3 October and all passed.

| Check | Result and scope |
|---|---|
| `npm test` | 15/15 pass: repeated turns, overlapping chats, late events, session closure, text fallbacks, badges/focus, legacy payloads, pause, and selected Claude/approval regressions |
| TypeScript check | `tsc --noEmit` passed |
| `npm run pack` | Frontend, optimized Rust executable, and NSIS installer built successfully |
| Standalone release | Executable ran with the Vite development server stopped |
| Synthetic relay sequence | Completion, next-turn tool activity, overlapping chat closure, a stale Stop, and second completion exercised |
| Two real consecutive Codex turns | Both completed; the native UI showed **Codex finished** with each turn's final response |
| `git diff --check` | Passed for the implementation changes |

The regression suite executes the actual TypeScript hook/state logic with
mocked native bridge, sound, and island UI. It is not a full native UI test.
The two real Codex turns were simple ephemeral app-server turns without tool
calls; they do not establish end-to-end approval support.

The overlap scenario also had live event-log and accessibility-text evidence.
An additional attempt to expand the compact island for visual inspection was
inconclusive because automation clicks reached the underlying window. That is
a verification gap, not a confirmed new UI defect.

A local 0.1.1 installer was produced. Fresh installation, upgrade, and uninstall
were not tested, and no signed release was published as part of this work.
Linux and macOS builds were not validated for these Windows changes.

## Current problems and next phases

### Phase 1 — Windows actions and chat setup

**Observed:** the button labelled `Open terminal` calls `open_in_vscode`.
That backend launches VS Code with the working folder and has no explicit
`--reuse-window` option. It falls back to the file manager. It does not reconnect
to the originating Codex chat.

**Observed:** Mochi chat calls the Anthropic API through `claude.rs`. Its
`API key missing. Open settings.` error means the credential lookup returned no
usable key; the current lookup also collapses credential-read errors into that
result. Settings already supports saving and clearing the key. Signing into
Codex does not configure this separate chat client.

Proposed work:

- Provide a real terminal action using Windows Terminal with a PowerShell
  fallback, and a separate VS Code action with explicit window reuse.
- Give missing-key errors a direct Settings action. Distinguish absent keys,
  credential-store failures, rejected credentials, network errors, and API errors.
- Verify saving, reading, and clearing credentials without exposing keys in
  logs or the UI; add a deliberate connection test if needed.

**Done when:** actions have accurate labels, use the intended working folder,
handle missing applications and invalid paths clearly, and safely support paths
with spaces and non-ASCII characters. Chat setup either produces a successful
reply or a specific, actionable error. Opening a new terminal does not by itself
restore an existing Codex session; source-aware navigation needs separate work.

### Phase 2 — Codex hook setup and diagnostics

**Current gap:** Windows Settings installs Claude Code hooks, but does not
install or repair Codex hooks. The tested Codex configuration is machine-local.

Proposed work:

- Add a Codex Hooks section with installation status and delivery diagnostics.
- Preview edits, take a dated backup, and preserve unrelated configuration.
- Generate valid PowerShell `commandWindows` entries and validate the relay path.
- Explain/check the applicable Codex trust step; do not silently approve trust.
- Make repeated installation, repair, and removal safe and predictable.

**Done when:** a fresh Windows account can configure hooks using the documented
flow, observe prompt/tool/Stop delivery, and remove only Coucou's entries.
Test absent files, existing unrelated hooks, malformed JSON, and failed writes.

### Phase 3 — Codex approvals

**Current gap:** external-agent `PermissionRequest` events are declined by
Coucou without a decision so the originating agent can handle them. The tested
Codex hook configuration does not register this event.

First verify the supported Codex approval protocol, event availability, response
schema, identifiers, and timeout behavior. The existing Claude response format
must not be assumed compatible.

Then implement explicit Allow/Deny, request/session correlation, stale-request
protection, and timeout/closed-app fallback, using reliable delivery from Phase 2.

**Done when:** a controlled real Codex request accepts the user's explicit
decision, concurrent requests cannot be confused, and unanswered requests return
control safely. No silent approval or persistent blanket permission is proposed.

### Phase 4 — Multiple chats and release quality

- Add clear project/session labels and evaluate a small session picker.
- Test restart, interruption, crashes, lost events, and prolonged multi-session use.
- Add native integration coverage for launching apps, credentials, hooks, and
  approval responses; complete the compact/expanded island interaction checks.
- Validate fresh install, upgrade, and uninstall on a clean Windows environment.
- Update release notes and assess code signing before publishing an installer.

**Done when:** active/result selection is understandable, the recovery cases have
documented outcomes, and another Windows machine can install and exercise the
supported workflow using the published instructions.

Start with Phase 1. The terminal action and chat setup are visible usability
problems with a smaller scope than approval support. These phases have no
assigned owners or delivery dates yet.

## Collaborator workflow

Prerequisites: Node 20+, Rust, MSVC C++ build tools, and WebView2 as described in
the [Windows README](../windows/README.md#build-it-yourself).

```powershell
git clone --branch windows-codex https://github.com/kojos03/coucou.git
cd coucou/windows
npm install
npm test
npm run tauri dev
```

For a release build, run `npm run pack` from `windows/`.
Before testing real Codex events, run Coucou and verify that Codex has enabled,
trusted hooks pointing to the installed relay. Cloning does not copy the tested
machine's configuration. The current log is `%LOCALAPPDATA%\Coucou\coucou.log`.

For each change, branch from `windows-codex`, keep the scope focused, document
acceptance checks and results, and open a pull request against
`kojos03/coucou:windows-codex`. Keep this status note synchronized with completed
work; move a planned item only after its checks pass.

Do not commit API keys, credential exports, personal `%USERPROFILE%\.codex`
files, raw session logs, `node_modules/`, `target/`, `dist/`, or installers.
Use sanitized examples for debugging and release assets for distributable builds.
