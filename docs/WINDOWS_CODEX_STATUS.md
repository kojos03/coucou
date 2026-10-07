# Windows Codex integration: progress and next phases

Last updated: 7 October 2026 (section 19: Copilot CLI and Muse Code). On 5 October
**`windows-codex` became the latest working version** — everything from `windows-codex-claude` and `windows-plan-usage`
(sections 7–14), with upstream Coucou 0.1.8 merged. The upstream review is in
[UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md).

This is the engineering handoff for Konstantinos and Zack on the
[kojos03/coucou fork](https://github.com/kojos03/coucou). The Windows work is
split across these branches; the fork's `main` branch is a separate line of
development.

| Branch | Contents | State |
|---|---|---|
| `windows-codex` | **Latest working version** (5 October): fast-forwarded to `windows-plan-usage`, so it contains every branch below, Zack's merge of the documentation pull request (#1) and upstream Coucou 0.1.8. Started from [ee6176f — Fix Windows Codex activity and completion lifecycle](https://github.com/kojos03/coucou/commit/ee6176f7c42103de18d298d3a90969097204665f) | Pushed; integration branch |
| `windows-codex-documentation` | [2967bb8 — Document Windows Codex progress and next phases](https://github.com/kojos03/coucou/commit/2967bb80ad60e8e7dbeb6d64ebad011ecb4ec047), on top of `ee6176f` | Pushed |
| `windows-phase1` | [3a8f2cd — Fix Windows launch actions and Mochi chat setup](https://github.com/kojos03/coucou/commit/3a8f2cdea98b3e1d9cc50349b6a94e9dd9ac6b50) and `c95d7ee` (review fix and this note), on top of `2967bb8` | Pushed; merged into `windows-codex` (5 October) |
| `windows-codex-claude` | Main working version until 5 October. Two Mochis and chats (section 7), subscriptions, Codex hook setup and named pills (section 8), Claude's Mochi on the Claude plan (section 9), upstream 0.1.4 merged and Codex approvals and visual parity (section 10), on top of `windows-phase1` | Pushed; merged into `windows-codex` (5 October) |
| `windows-plan-usage` | Claude plan usage (section 13), live usage for both plans and the internet speed (section 14), upstream Coucou 0.1.8 merged, on top of `windows-codex-claude` | Pushed; merged into `windows-codex` (5 October) |

**Current status (3 October; see section 14 for later):** `windows-codex-claude` was the main working version. It
passes every automated check natively on Windows, including the opt-in native
tests, and the release build runs on the development machine. Claude's Mochi
answered live in the island on the user's Claude Pro plan, with web search and a
follow-up turn (section 9). Codex approvals work end to end through the real
relay and island with simulated Codex events (section 10). Not yet confirmed: a
real Codex session asking for approval (needs the hooks repair and Codex usage,
which resumes on 4 October), a live reply from Codex's Mochi, file drops on
either plan, and a prolonged Claude Code + Codex session. Phases 2 and 3 are
implemented on this branch; Phase 4 is proposed work, and the remaining
upstream features are planned in
[UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md).

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

### 5. Implemented Phase 1: Windows actions and chat setup

Implemented in `3a8f2cd` on `windows-phase1`. What has and has not been checked
is listed under [What was verified](#what-was-verified) and
[Outstanding Phase 1 validation](#outstanding-phase-1-validation).

**Launch actions**

- The finished card has **Open terminal**, **Open in VS Code**, and **OK**. The ↗
  button opens VS Code for the Claude Code pill and a terminal for agent pills
  (Codex and other `coucou_agent` agents). Integration pills keep their web
  targets.
- Both actions use the focused pill's working folder. Codex uses the folder of
  the session its pill is showing. The folder must be an absolute path to an
  existing directory; otherwise the island shows a specific message in the note
  view and plays the error sound.
- **Open terminal** on Windows opens a new tab in the most recent Windows
  Terminal window when `wt` is on `PATH`, running Windows PowerShell 5.1 with
  `-NoLogo -NoProfile -NoExit`. The folder is set as the process working
  directory and passed as `--startingDirectory .`, so neither `wt`'s `;` command
  parser nor a shell reads the path. If `wt` cannot be started, Windows
  PowerShell opens in a new console window in the same folder.
- **Open in VS Code** runs `code --reuse-window <folder>`, with the folder as a
  separate argument, and reports an error when `code` is not on `PATH`. The
  earlier fallback to Explorer was removed.
- On Linux, **Open terminal** shows a message pointing to **Open in VS Code**.

**Mochi chat and credentials**

- Chat failures are structured (`code`, `message`, `settings`). They distinguish
  a missing key, an unreadable credential store, a rejected key (401), missing
  permissions (403), an unavailable model (404), billing or credits (402, or 400
  mentioning credit/billing), invalid or oversized requests, rate limits,
  service errors, timeouts, network failures, unreadable responses, and
  refusals. API response bodies and key values are not passed to the UI.
- A failed turn is rolled back in Rust and in the island. The question returns
  to the input field and the first dropped file stays attached. The error offers
  **Retry** and, for setup problems, **Chat settings**, which opens Settings at
  the chat section.
- Credential reads distinguish an absent key from a credential-store failure.
  Saving reads the value back to verify it, and removing verifies that it is
  gone. Settings reports "Could not check the credential store" instead of
  claiming that no key exists.
- Settings → **Mochi chat · Anthropic** has **Test connection**, which calls
  `GET /v1/models/{model}` with the saved key. Success means Anthropic accepted
  the key and the key can see the selected model. It sends no chat message and
  does not verify credits, billing, or message generation. A typed key must be
  saved before it can be tested.

**Tests and tools**

- `phase1.test.mjs`: 7 view-level tests covering chat errors, retry, duplicate
  sends, credential presence, save/remove, failed writes, and the connection test.
- Rust: folder validation, terminal and VS Code argument construction, API error
  mapping (including that response bodies are not echoed), and unknown
  credential names. Three native tests are marked `#[ignore]` and run only on
  request: an isolated Credential Manager round trip, PowerShell working-folder
  preservation, and a Windows Terminal tab working-folder check.
- `windows/dev/phase1-preview.html` previews the chat error and the finished
  card in a browser through `npm run dev`.

### 6. Phase 1 review at handover

`3a8f2cd` was reviewed against the Phase 1 goals. One regression was found and
fixed in the working tree of `windows-phase1`; the fix is not yet committed.

- **Fixed: other agents had no working folder.** Only Claude Code and Codex
  recorded the hook's `cwd`. For any other `coucou_agent` agent, **Open
  terminal** on the finished card and the ↗ button always reported "No working
  folder is available", although the hook payload included one. Before Phase 1,
  the button opened VS Code without a folder. [hooks.ts](../windows/src/island/hooks.ts)
  now keeps the latest `cwd` for those pills; Codex still uses the selected
  session's folder. A regression test in `hooks.test.mjs` fails without the fix
  and passes with it.
- **Documentation:** the Windows README now describes the separate terminal and
  VS Code actions, the Linux behavior, the chat key settings, and where Phase 1
  lives.

Found in the review and **not** changed. Each item needs a decision or native
testing:

1. **`--reuse-window` may replace another project.** Expected VS Code behavior,
   to confirm during validation: a folder that is already open in a window is
   focused either way. Otherwise `--reuse-window` loads it into the last active
   window, replacing that window's project, whereas a plain `code <folder>` opens
   a new window. Decide which behavior is intended.
2. **The terminal ignores the user's shell setup.** It always starts Windows
   PowerShell 5.1 with `-NoProfile`, not the Windows Terminal default profile
   (for example PowerShell 7), and skips the user's PowerShell profile.
3. **Linux regression.** On Linux, **Open terminal** used to open VS Code; it now
   shows a message, and the finished card still shows the button.
4. **Chat reset during a pending reply (existed before Phase 1).** Dropping a
   file while a reply is pending resets the conversation. The late reply is then
   stored as the first message of the new conversation, so the Rust history
   starts with an assistant turn, the next request can fail, and the new file is
   not attached. **Fixed on `windows-codex-claude`** (section 7) with a
   conversation generation check in Rust and the same check in the island.
5. **Codex running in WSL.** A Linux `cwd` such as `/home/...` is not an absolute
   Windows path, so both actions report the folder as unavailable.
6. **Wording.** The credential-store error says "Unlock it and try again", which
   suits the Linux Secret Service better than the Windows Credential Manager.
7. **Native test caveat.** The ignored Windows Terminal test passes its output
   path to the new tab through an environment variable. With `-w 0` and an open
   Terminal window, check that the tab received it before treating a timeout as
   a product failure.

### 7. Two Mochis: Anthropic and OpenAI (`windows-codex-claude`)

Claude Code and Codex each get their own Mochi chat.

- **Which Mochi answers.** The focused pill decides: with the Codex pill
  focused, chat goes to OpenAI; with any other pill (Claude Code, other agents,
  integrations), it goes to Anthropic. The rule lives in `chatProviderFor` in
  [state.ts](../windows/src/core/state.ts) and follows the pill whose Mochi is on
  screen.
- **Look.** No drawing change was needed: the island already draws the big
  Mochi in the focused pill's colour ([island.ts](../windows/src/island/island.ts),
  `bodyColor`), so Codex's Mochi is pink and Claude Code's is near-white. In
  Codex's chat the input placeholder also ends with "(OpenAI)"; Claude's keeps
  its original wording.
- **Separate conversations.** Rust keeps one history per Mochi and the island
  one list per Mochi; switching pills swaps the conversation, pending reply, and
  error. Dropping a file starts new conversations with both. A reply that
  arrives after such a reset is discarded on both sides (review item 4).
- **OpenAI client** ([openai.rs](../windows/src-tauri/src/openai.rs)): the
  Responses API with the `web_search` tool, the same system prompt as Claude's
  Mochi, `store: false` (the history stays in Coucou and is resent each turn),
  and a 16,384-token output budget, since reasoning counts against it. Dropped
  files mirror `claude.rs`: PDFs as `input_file`, PNG/JPEG/GIF/WebP as
  `input_image`, other files inline as text up to 200 KB.
- **Errors** use the same structured codes as Claude's Mochi. OpenAI reports
  billing problems as HTTP 429, so `credit_balance_exhausted`, the spend/usage
  limit codes, and `insufficient_quota` map to billing; other 429s are rate
  limits. Messages name the Mochi, and **Chat settings** opens that Mochi's
  section. Response bodies and keys are not passed to the UI.
- **Settings.** **Claude's Mochi · Anthropic** and **Codex's Mochi · OpenAI**
  share one component. The OpenAI key is stored as `openai-api-key` in the
  credential store; the model is the new `openaiModel` setting (default
  `gpt-6.1-sol`; the list offers `gpt-6.1-sol`, `gpt-6-astra`, and `gpt-6-luna`,
  OpenAI's flagship models in its documentation in October 2026). Older
  `settings.json` files load with the default. **Test connection** calls
  `GET /v1/models/{model}` and sends no message.

**Verified** on Windows on 3 October, run natively through Desktop Commander:
`npm test` 27/27; `npx tsc --noEmit`; `cargo test -p coucou --lib --locked`
19 passed and 3 native tests ignored; `cargo check --workspace --locked` with no
warnings; `npm run build`. The Settings window and Codex's chat error were
checked in a browser through `dev/phase1-preview.html` with the native bridge
mocked.

**Not verified:** no real Anthropic or OpenAI request was made (no key was
used), so the web search tool, file inputs, model availability, and real error
bodies are untested against the live APIs. The running app was not exercised:
the installed Coucou was running, and the app allows a single instance.

### 8. Subscriptions, Codex hook setup and named pills (`windows-codex-claude`)

**Pills.** Claude Code and Codex always appear as their own mini Mochis,
labelled **Claude Code** (white; it said "VS Code" before) and **Codex** (pink).
The ticker still shows the Claude Code project name during a session. Clicking a
pill makes it the big Mochi and the chat target.

**Codex's Mochi on the ChatGPT plan** ([codex_cli.rs](../windows/src-tauri/src/codex_cli.rs)).
The new default sign-in runs the official Codex CLI the user is signed in to:
`codex exec --ephemeral --skip-git-repo-check --sandbox read-only --disable hooks
-c web_search=live -c model_reasoning_effort=low -C <Coucou folder> -o <reply file> -`.
The prompt goes through stdin, so nothing typed reaches a command line. Each
turn carries the conversation so far (Codex keeps no session for these chats).
Dropped images are passed with `-i` on every turn; text files are inlined; PDFs
are referenced by path. A run is killed (whole process tree) after 4 minutes.
Codex's own errors are mapped to actionable messages without echoing its
output: usage limit (with Codex's retry time), not signed in, rate limit,
network. **Test connection** runs `codex login status`. The OpenAI API key mode
from section 7 remains available as the alternative.

**Claude Code hand-off.** At this point Claude's Mochi kept the Anthropic API
key (section 9 replaces that with the Claude plan). Without a key, the chat
error offers **Ask in Claude Code**
([launch.rs](../windows/src-tauri/src/launch.rs)): the question is saved as
`%LOCALAPPDATA%\Coucou\mochi\claude\question-<time>.md` and the official Claude
Code opens in a Windows Terminal tab (PowerShell window as fallback) with
`@question-<time>.md`, so it runs on the user's own Claude sign-in.

**Codex hooks in Settings** ([codex_hooks.rs](../windows/src-tauri/src/codex_hooks.rs)).
The Codex section reads `$CODEX_HOME/hooks.json` (default `~/.codex`), reports
each of the 8 followed events as registered, missing, or needing repair, and
shows when Codex last reached Coucou (tracked per agent in `pipe.rs`; Claude
Code gets the same line). Install/repair writes the same entries as the
hand-repaired configuration (`&` call operator, timeout 3, async except
SessionEnd), leaves correct entries untouched so Codex does not ask for
re-trust, removes duplicates and broken Coucou entries, and keeps foreign hooks
and fields. Every write shows the diff, checks the file still matches the
preview, takes a `hooks.json.bak-coucou-<time>` backup, and replaces the file
atomically. Invalid JSON or a `hooks` value of the wrong shape is reported and
never overwritten. After a change the UI tells the user to run `/hooks` in
Codex. PermissionRequest is still not registered (Phase 3).

**Verified on Windows, 3 October** (natively, through Desktop Commander):

| Check | Result |
|---|---|
| `npm test` | 31/31 (17 hook + 14 view tests) |
| `npx tsc --noEmit` | Pass |
| `cargo test -p coucou --lib --locked` | 30 passed, 3 ignored, no warnings |
| `cargo test … -- --ignored` (native) | 3/3: Credential Manager round trip; PowerShell and a real Windows Terminal tab open in a folder named with `&`, `%`, `;`, `'` and non-ASCII characters |
| `npx tauri build --no-bundle` | Release executable built (2 min 9 s), no warnings |
| Release app | Old Coucou stopped, new build started through Explorer, log shows `Coucou 0.1.1 started` |
| Island, by hand | Codex focused shows the pink Mochi; the **Claude Code** pill switches to the white Mochi with "Hooks not installed" |
| Claude chat, by hand | Without a key: the error, **Ask in Claude Code**, **Chat settings** and **Retry**; the hand-off wrote the question file and started `wt … claude.exe @question-….md` |
| Settings, by hand | Real `hooks.json` reported as 8 of 8 registered (no rewrite needed); Claude Code shows **Install hooks…** |
| `codex exec` invocation | Ran with the arguments above and reached the model, but the ChatGPT plan's Codex usage limit was reached (reset 9:31 PM); no hook events were logged for these runs, confirming `--disable hooks` |
| Browser preview | Settings sections checked; caught and fixed the API key and Model rows staying visible in ChatGPT-plan mode |

Claude Code 2.1.288 was installed with Anthropic's official installer
(`irm https://claude.ai/install.ps1 | iex`, signed by Anthropic, PBC).

**Not verified yet:** a successful Codex's Mochi reply on the ChatGPT plan
(after the usage limit resets), web search and image input through `codex exec`,
any Anthropic reply (no key), Claude Code sign-in and its hooks delivering to
the island, writing hooks.json from the real Settings window (not needed here),
and a prolonged Claude Code + Codex session.

### 9. Claude's Mochi on the Claude plan (`windows-codex-claude`)

**Why this changed.** Section 8 kept Claude's Mochi on an API key. On
3 October Anthropic's legal and compliance page was re-read: it does not allow
third-party developers to offer Claude.ai sign-in or to route requests through
Free, Pro or Max credentials on users' behalf, but it does not prevent a user
from signing in to the unmodified Claude Code binary with their own
subscription. Coucou now does only that: it runs the user's own installed,
signed-in `claude.exe` and never handles the sign-in, its tokens or its
requests. Anthropic has also described a change, currently paused, that would
bill non-interactive (`claude -p`) use from a separate credit pool; if it
comes back, plan chats may count differently. The API key mode stays as the alternative.

**How it runs** ([claude_cli.rs](../windows/src-tauri/src/claude_cli.rs)), in
the empty folder `%LOCALAPPDATA%\Coucou\mochi\claude-chat`:

```
claude -p --output-format json --no-session-persistence --restricted --safe-mode
  --settings {"disableAllHooks":true} --permission-mode dontAsk
  --tools Read,WebSearch,WebFetch --allowedTools Read,WebSearch,WebFetch
  --effort low --system-prompt <Mochi's prompt> [--add-dir <folder of a dropped file>]
```

- The message goes through stdin, and each turn carries the conversation so far.
- Restricted mode removes every tool that runs commands and confines file reads
  to the working folders; `dontAsk` refuses anything not pre-approved. Safe
  mode and `disableAllHooks` keep hooks, plugins, MCP servers and CLAUDE.md
  files out, so Mochi's own runs never appear as Claude Code activity.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDECODE` are removed from
  the child's environment, so the plan is used rather than a key.
- Text files up to 200 KB are inlined. Images, PDFs and larger files are read
  by Claude Code itself; the file's folder (Coucou's inbox) is added with
  `--add-dir` for the rest of the conversation.
- The JSON result (`is_error`, `result`, `api_error_status`) maps to: not signed
  in, usage limit (with Claude Code's reset time), outdated Claude Code, busy,
  network, or a generic error. Nothing else from Claude Code's output reaches
  the UI. A run is killed (whole process tree) after 4 minutes.
- **Test connection** runs `claude auth status` and reads `loggedIn`.
- The prompt asks for plain URLs, since Claude Code's web search otherwise
  cites Markdown links, which the bubble shows as raw text.
- Settings gains `anthropicAuth` (`claudeCode`, the default, or `apiKey`) and a
  **Sign in with** choice in Claude's section. Both Mochis' sections now share
  one plan sign-in description in [main.ts](../windows/src/settings/main.ts). On
  a plan the Model row is hidden: Claude Code picks the model for the plan
  (Sonnet 5.5 on this Pro account).
- **Fix:** `codex login status` prints on stderr, so Codex's **Test
  connection** reported "not signed in" for a signed-in Codex. It now reads
  both streams.

**Verified on Windows, 3 October, late evening** (natively, through Desktop
Commander and by hand in the release build):

| Check | Result |
|---|---|
| `npm test` | 32/32 (17 hook + 15 view tests) |
| `npx tsc --noEmit` | Pass |
| `cargo test -p coucou --lib --locked` | 36 passed, 7 ignored, no warnings |
| Native opt-in tests | `claude auth status` detects the sign-in; `claude -p` through Coucou's own runner answered "pong"; `codex login status` detects the sign-in |
| `npx tauri build --no-bundle` | Built twice (2 min 12 s), no warnings; restarted through Explorer |
| Claude's Mochi, live in the island | Claude Code pill focused: answered on the Pro plan with a web search (latest Rust and Node.js LTS releases, citing a plain URL after the prompt change); a follow-up turn recalled the first question |
| Hooks stay off | Coucou's Claude Code hooks are installed in `~/.claude/settings.json`, yet the log shows no hook event during Mochi's runs, and no transcript folder was created under `~/.claude/projects` |
| Codex's Mochi, live in the island | Codex pill focused: Codex's real usage-limit error shown as "Codex says you can try again at Oct 4th", with **Retry** |
| Error shapes | Signed out (an empty `CLAUDE_CONFIG_DIR`): `is_error` with "Not logged in · Please run /login", and `auth status` `loggedIn: false`; an unknown flag: "error: unknown option". Both are covered by tests |

**Not verified:** a Claude plan usage-limit reply (matched from known
wordings: "hit your limit", "limit reached", "usage limit", "resets …"); an image
or PDF dropped on either Mochi; a Codex's Mochi reply (limit until 4 October);
Claude Code signed in with a Console account instead of a plan; the new **Sign in with** choice clicked by hand in the
Settings window (covered by the view test only).

**Upstream.** [Louis-CFM/coucou](https://github.com/Louis-CFM/coucou) was
reviewed the same evening. Its 17 new commits are macOS-only and merge without
conflicts; the features worth porting and their order are in
[UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md).

### 10. Upstream 0.1.4, Codex approvals and the Codex pill (`windows-codex-claude`)

**Upstream merged.** Louis-CFM/coucou `main` at `35886ec` (0.1.4) is merged as
`9fbe01a`: no conflicts and nothing under `windows/` changed. The Windows checks
were rerun on the merge (npm 32/32, tsc, cargo 36 passed).

**Codex approvals (Phase 3).** Checked against the installed Codex 0.160 first:
its hook engine knows `PermissionRequest` and `Interrupt`, the `statusMessage`
handler field, and the decision `{"hookSpecificOutput":{"hookEventName":
"PermissionRequest","decision":{"behavior":"allow"|"deny","message":…}}}`;
`updatedPermissions` and `updatedInput` make the hook fail closed, so there is
no "Always". The relay already printed exactly that shape.

- [codex_hooks.rs](../windows/src-tauri/src/codex_hooks.rs) registers
  `PermissionRequest` (synchronous, 120 s timeout, statusMessage *Waiting for
  your answer in Coucou*) and `Interrupt`. Repair leaves the 8 existing entries
  byte-identical, so Codex only asks the user to review the 2 new ones.
- [pipe.rs](../windows/src-tauri/src/pipe.rs): while a request waits, Coucou
  also notices the relay hanging up (the agent stopped waiting) and tells the
  island (`approval-gone`).
- [hooks.ts](../windows/src/island/hooks.ts): a Codex request gets the same
  card as Claude Code: one card at a time, acknowledged within 800 ms, gone after
  110 s, a badge and a reveal when another pill is focused. The card shows the
  command, or the files of an `apply_patch`. It comes down with *Handled in
  Codex.* when the relay hangs up, or when the same chat stops, ends, is
  interrupted or gets a new prompt (the waiting request is then released).
  Clicking a pill that asks for permission opens its card. Other agents still
  decline, as before.

**The Codex pill, on a par with Claude Code's** (at the user's request: the name
stays *Codex*, the second label reads *Integration*, the colour is light blue
`#7DD3FC` instead of pink):

- No chat running: an integration card like Claude Code's: *Codex ·
  Integration*, a status dot (green *Connected*, amber *Connected · repair
  hooks*, red *Hooks not installed*), **Open Codex** when the Codex app from the
  Microsoft Store is installed (started through `shell:AppsFolder`), and
  **Refresh** or **Settings…** (which opens the Codex section).
- During a chat: the ticker reads *Codex · Integration* with the steps, using the
  macOS labels for Codex's tools (`apply_patch` shows the file, `update_plan`,
  `spawn_agent`, `mcp__server__tool`, and shell verbs, PowerShell included). A
  new chat plays the work sound, a rate limit its sound, and a finished turn
  settles to idle after 5.2 s keeping its steps, as Claude Code's does.
- Cards: *Codex finished*; the error card names Codex (it said Claude Code); the
  question card says *Codex is asking a question*; the island's settings row
  shows a Codex hooks badge next to Claude Code's.

**Ticker fixes, for Claude Code too.** Switching pills kept the previous pill's
lines; queued steps stalled whenever the Mochi stood still (its motion was the
only thing keeping the frame loop alive); and WebView2 drew the current row on
top of the completed one after a transition (the rows' `will-change` layers).
The last one was found by comparing the DOM, read through WebView2's DevTools
protocol on a debug launch, with a capture of the screen.

**Verified on Windows, 3 October, night:**

| Check | Result |
|---|---|
| `npm test` | 46/46 (25 hook, 15 Phase 1 and chat, 6 Codex view tests) |
| `npx tsc --noEmit` | Pass |
| `cargo test -p coucou --lib --locked` | 38 passed, 7 ignored, no warnings |
| `npx tauri build --no-bundle` | Built after each round, no warnings |
| Simulated Codex chat through the real relay into the running app | Ticker, approval cards for a command and for a patch, idle card with *Connected · repair hooks* and **Open Codex** |
| Allow | Clicked on the card: the relay printed `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` and exited. The user also clicked Allow on two simulated cards |
| Codex stops waiting | The relay was killed 1.2 s after its request: the log shows the hang-up and the card turned into *Handled in Codex.* within a second |

**Not verified:** a real Codex session asking for approval (needs **Repair
hooks…** in Settings, `/hooks` in Codex, and Codex usage, which resumes on
4 October); **Deny** answered to a real Codex; real `Interrupt` events;
clicking **Open Codex**; writing the real `hooks.json` from Settings (left for
the user's click).

### 11. Claude orange, Open Claude app, and a VS Code pill (`windows-codex-claude`)

At the user's request:

- The **Claude Code** pill and Claude's Mochi use Claude's orange, `#D97757`
  (they were near-white).
- Its idle card's link is **Open Claude app** instead of **Open Visual Studio
  Code**, and its ↗ button does the same. [launch.rs](../windows/src-tauri/src/launch.rs)
  starts the Store app (`Claude_pzs8sxrjxfjjc!Claude` through
  `shell:AppsFolder`, found by its `%LOCALAPPDATA%\Packages` folder), or the
  older per-user `%LOCALAPPDATA%\AnthropicClaude\claude.exe`. The finished
  card keeps **Open in VS Code** for the session folder.
- **VS Code** is a new integration pill, `integration_vscode`, purple
  `#A855F7`. It is selectable in Settings → Integrations like the others (the
  island shows four integrations at most), first in the list and in pill order.
  Its card reads *VS Code · Integration*, *Installed* or *Not installed*
  (whether `code` is on `PATH`), and **Open Visual Studio Code**; ↗ does the
  same. No pill ID was renamed. On the development machine it replaced Resend
  in the four active integrations, as the user chose.

### 12. Codex auto-review and Open in Codex (`windows-codex-claude`)

Two reports from the first real Codex approval (4 October, 12:55):

- **The island asked about a command the Codex chat was not asking about.**
  The Codex app runs chats with `approval_policy = "on-request"` and
  `approvals_reviewer = "auto_review"`: approvals go to Codex's own reviewer
  agent, not to a person. Codex resolves an approval as *hooks first, then the
  reviewer* (`Session::request_approval` in `codex-rs/core/src/tools/approvals.rs`),
  so our PermissionRequest hook stood in front of the reviewer, showed a card
  and held Codex until the click (9 s that time). The hook payload has no
  reviewer field (`permission_mode` is `default` either way), but it names the
  session transcript, whose `turn_context` records carry `approvals_reviewer`.
  The relay used to drop `transcript_path` from every event; it now keeps it
  for Codex PermissionRequests only, and Coucou removes it before the island
  sees the request.
  [codex_review.rs](../windows/src-tauri/src/codex_review.rs) reads that one
  field (this turn's record, else the latest; at most the last 32 MB; `.jsonl`
  only; nothing kept), and [pipe.rs](../windows/src-tauri/src/pipe.rs) closes a
  Codex request at once when the reviewer is not `user`: the relay prints
  nothing and Codex's reviewer decides, as without Coucou. A chat whose
  approvals go to the user, or a transcript Coucou cannot read, still gets the
  island's card.
- **The finished card offered a terminal for a chat that lives in the Codex
  app.** A finished Codex chat now offers **Open in Codex**, **Open in VS Code**
  and **OK** when the Codex app is installed. **Open in Codex** opens that chat
  through the app's own link, `codex://threads/<thread id>` (the `codex`
  protocol is declared in the app's manifest; the hook's `session_id` is the
  thread id). The id is checked to be hex and dashes before it reaches
  `explorer.exe`. Without the app, or without a chat id, the card keeps **Open
  terminal**. Claude Code's finished card is unchanged.

Verified with the release build: a simulated Codex request carrying the real
auto-review chat's transcript got no output in under 100 ms and no card
(logged *left to Codex auto-review*); one whose transcript names `user` still
got the card, which came down when the relay hung up; and clicking **Open in
Codex** on a simulated finished turn switched the Codex app to that chat. Not
yet seen: a real Codex chat after the change.

### 13. Claude plan usage (`windows-plan-usage`, upstream #159)

The next port in [UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md),
on its own branch for a pull request into `windows-codex-claude`:

- **Relay.** `coucou-hook --statusline` ([statusline.rs](../windows/hook/src/statusline.rs))
  is Claude Code's status line command. It sends Coucou only `rate_limits` and
  the session id, under the usual fire-and-forget budget, then prints the
  status line: the user's own, if Coucou saved one beside the relay
  (`statusline-previous.json`, run with the same stdin through Git Bash, or
  PowerShell without it, as Claude Code would, 10 s at most), or else
  `5h 23% · week 41%`. Upstream prints nothing in that case; a short line
  seemed better than an empty status row.
- **Coucou.** [plan_usage.rs](../windows/src-tauri/src/plan_usage.rs) validates
  the windows as upstream does (percent 0–200 clamped to 100, reset times in
  seconds and at most 400 days ahead), keeps the latest in memory and in
  `%LOCALAPPDATA%\Coucou\plan-usage.json`, and sends it to the island. Its
  installer writes the `statusLine` key through the hooks' own preview,
  fingerprint, backup and atomic write (`preview_of`, `read_unchanged`,
  `replace_settings`, split out of `hooks::write` without changing it).
  Installing over a user's status line swaps only its `command` and saves the
  original first; removing restores it exactly, or drops the key; a status
  line that is not Coucou's is never removed.
- **Island.** A small header pill on the home view, *Claude 73%*, coloured by
  the fuller window (green < 50 %, amber < 80 %, red), shown when **Show in the
  island** is on and the status line is installed. It opens the plan card in
  place of the left card (both windows, bars, reset times, "just now"), Mochi
  takes the plan colour meanwhile, and choosing a pill, another view or
  closing the island closes it ([plan.ts](../windows/src/core/plan.ts),
  [views/plan.ts](../windows/src/views/plan.ts)).
- **Settings.** *Claude plan usage* under Claude Code: the switch, the status
  line state (and the user's own one it keeps running), and Install / Remove
  with the diff. Turning the switch on without the status line opens the
  install diff; **Cancel** writes nothing.

- **Usage on the cards** (asked for after the first review). Both the Claude
  Code and the Codex card show a usage line under *Connected*: `5h ▬ 62%
  week ▬ 35%`, coloured per window, with the reset times as a tooltip; a click
  opens the plan card (with a back arrow). Without its status line, the Claude
  card offers **Show plan usage…**, which opens that Settings section; the
  header pill is now optional (**Pill in the header**). The Claude card's
  status also reads *Connected* rather than *Connected · loading…*: it has
  nothing to load.
- **Codex usage.** Codex records its ChatGPT plan windows itself: every reply
  in a session log carries a `token_count` event whose `rate_limits` has
  `primary` (300 minutes) and `secondary` (10080 minutes), each with
  `used_percent` and `resets_at`. `plan_usage::refresh_codex` reads the newest
  logs of the last two days (and the finished chat's own log, found by its
  thread id in the last 14 days), takes the latest reading by its timestamp,
  keeps it in `codex-usage.json`, and sends it to the island — at launch and
  after each Codex `Stop`. Windows go by their length, not their slot. No
  request is made and nothing leaves the machine.

Verified with the release build against a scratch home folder (never the
real `~/.claude/settings.json`): the switch opened the install diff (only the
`command` of an existing status line swapped, `padding` kept), **Back up and
write** saved the original beside the relay, and the status line command run
through Git Bash exactly as installed printed the user's own line while the
island's pill and card showed the forwarded numbers (amber 62 %, then green
12 % with no weekly window); **Remove status line…** restored the file
exactly, deleted the saved copy and turned the pill off. With no saved status
line the relay printed `5h 24% · week 41%` in about 90 ms, and Coucou stored
only the two windows (no folder, cost or model). The same install and removal
also pass as an ignored native test in a scratch folder. On the real machine,
Coucou read the Codex numbers from the newest session log at launch (week
92 %; the 5-hour window had already reset, so 0 %), and the Codex card showed
them under *Connected*; the user has since installed the Claude status line
themselves, and the Claude Code card showed *Plan usage after Claude Code's
next reply*, then, fed one simulated status line (removed afterwards), the
usage line, its tooltip and the plan card with its back arrow. Not yet seen: a
real Claude Code reply feeding it, and a real Codex turn refreshing it.

### 14. Live usage for both plans, and internet speed (`windows-plan-usage`)

After using it for a day, the user reported three things:

- **The Codex card kept the old numbers after the limit was reached.** A turn
  that Codex refuses writes no `token_count` event, so the session logs held
  only readings from before the limit. Codex itself answers
  `account/rateLimits/read` over `codex app-server` (the read the Codex app
  makes for its usage view; no model call): `codex_cli::rate_limits` sends the
  `initialize` / `initialized` handshake and the read, takes the answer
  (about a second) and stops the server. On the development machine it
  returned the 5-hour window at 13 %, the week at 100 % and
  `rateLimitReachedType: "rate_limit_reached"`. Coucou asks at launch, after
  each Codex `Stop` (at most every 20 s), and while the Codex card is open (at
  most once a minute); the logs remain the fallback. `PlanUsage` gained
  `limitReached`, and the card line then reads *Weekly limit reached · resets
  Fri 9:00* instead of the gauges.
- **Claude's numbers never arrived, and Cowork should count too.** The plan's
  limits are one pool for Claude Code, Cowork and the Claude apps, but the
  status line only runs in Claude Code's terminal UI, which the user rarely
  uses. Claude Code reports the plan windows on every request
  (`rate_limit_event` in `--output-format stream-json`, with `unifiedWindows`
  holding `five_hour` and `seven_day`, `utilization` from 0 to 1, `resetsAt` in
  seconds; `status: "rejected"` at the limit). `claude_cli::plan_check` makes
  the smallest such request — Haiku, no tools, `--safe-mode --restricted
  --strict-mcp-config --disable-slash-commands`, a one-line system prompt, no
  session saved — measured at 416 input and 117 output tokens (without the
  safe flags, the user's plugins and skills made it 48,435). It runs only while
  the Claude Code card is open and its numbers are over ten minutes old, or on
  **Refresh** (20 s minimum). Claude's Mochi now uses stream-json too, so its
  chats bring the numbers at no extra cost; the status line still does from
  the terminal. Reading the Claude desktop app's own storage (where its usage
  banner lives) was ruled out: undocumented, compressed, and mixed with
  conversations.
- **The grey "Claude —" pill went, and the header shows internet speed.** The
  pill, its *Pill in the header* switch and the `showPlanUsage` setting are
  removed (the usage card line stays). [netspeed.rs](../windows/src-tauri/src/netspeed.rs)
  reads the physical adapters' byte counters (`GetIfTable2`, hardware
  interfaces that are up, filter drivers excluded so traffic is not counted
  twice; `/proc/net/dev` on Linux) once a second while the island is not
  hidden, and the header shows `↓ 18 Mbps ↑ 1.1 Mbps`. Nothing is downloaded
  to measure it.

**Launch at startup (5 October).** The login entry
(`HKCU\…\Run\Coucou`) holds the path of whichever build turned the setting
on, so turning it on from a debug build made Windows start the stale
`target\debug` copy. Debug builds now leave the entry alone when the setting
is turned on (they still remove it when it is turned off); on the development
machine it points at `target\release\coucou.exe`.

### 15. Claude Code in VS Code: the reply notifies, then the card clears (`windows-codex`)

The user runs Claude Code through the VS Code extension. A reply sometimes
brought no card, and the Claude Code card kept showing the turn's output
afterwards. Coucou's log and the session transcript showed every `Stop`
arriving (the hook ran in about 100 ms, no errors), so the island was at fault:

- **The output stayed.** The card showed the ticker whenever the pill had
  steps, and only `SessionEnd` cleared them, but a VS Code chat stays open for
  hours. Claude Code's card now shows the ticker only while a turn runs
  (finished included) and returns to *Connected* and the usage line once the
  pill is idle; each prompt starts a fresh ticker. Codex keeps its selected
  chat's steps, as before.
- **No card when another pill was focused.** A finish behind another pill only
  set a badge, even with the island hidden, so nothing appeared but the sound.
  It now opens the finished card on Claude Code unless the island is open on
  another pill, which still gets the badge; `StopFailure` follows the same
  rule. Codex's own path is unchanged.
- **Turns that end without `Stop`.** An interrupted turn sends none. Claude
  Code's `idle_prompt` notification (*Claude is waiting for your input*) now
  settles a running pill, and so do ten minutes without any event (Bash's
  longest timeout); the next event revives it.
- **One script error froze the island.** An exception in the frame loop left
  `running` set, so the loop never started again. The loop now survives it, a
  failing view no longer stops the island from opening, and script errors go to
  `coucou.log` (`ui  error …`), as does each result (`ui  Claude Code finished:
  card|badge, island was …`).

Verified: `npm test` (55, three new), `npx tsc --noEmit`, `cargo test -p coucou
--lib --locked` (53); a release build; and replays through the real relay
against the running app: the finished card, then *Connected · 5h 14% · week
65%*; a finish with Codex focused and the island compact opened the card;
`idle_prompt` settled a running turn; injected frame and view errors were logged
and the island still opened the next card. Not verified: a real interrupt in VS
Code, the ten-minute timer in the app, and whether the extension sends
`idle_prompt`. One session at 18:34 on 6 October (tool calls, no `Stop`, no
transcript, not in the VS Code log) is unexplained.

### 16. Mochi's wardrobe (`windows-codex`, upstream #195)

Right-click Mochi and the island opens his wardrobe, as on macOS: Auto, None
and eleven outfits drawn in code (party hat, beanie, crown, sunglasses, round
glasses, bow, scarf, witch hat, pumpkin, Santa hat, bunny ears). Hovering a tile
tries it on; a click keeps it (`pop` and a proud Mochi), saved as
`mochiOutfit` in `settings.json`. **Auto** follows the seasons with upstream's
dates (party hat 31 Dec–2 Jan, Santa hat 1–26 Dec, witch hat 1 Oct–1 Nov, bunny
ears Good Friday–Easter Monday, sunglasses 21 Jun–31 Aug). `Esc` or a second
right-click goes back to the overview.

- [outfits.ts](../windows/src/mochi/outfits.ts) ports `MochiWardrobe.swift` and
  `MochiOutfitDrawing.swift` to Canvas 2D: the head model, every outfit, the
  wardrobe icons. A SwiftUI context copy is a `save`/`restore` pair; its
  `drawLayer` is an offscreen layer, so a fading outfit never shows through
  itself.
- The engine gains the outfit's entrance and exit (180 ms out, 350 ms in with a
  squash), the spring that makes pompoms, hat tips and the scarf's end trail
  behind, the rigid roll (with an outfit on, the whole of Mochi turns), and the
  pumpkin's orange body.
- Who wears it: Claude Code's and Codex's Mochis, the compact island, and the
  wardrobe; integration cards and mini bots never do. macOS dresses only its
  main pill; Windows has two working Mochis, so both are dressed.
- Upstream's Easter rule compares times of day, which includes the Thursday
  before Good Friday from midnight; the port compares calendar days, which is
  what upstream's own tests expect.

Verified: `npm test` (60, five new in `tests/wardrobe.test.mjs`: the seasons,
every outfit drawn front and behind, entering, rolling, turned away and tiny,
the engine's transitions and spring, the wardrobe view), `npx tsc --noEmit`,
`cargo test -p coucou --lib --locked` (53), a release build; in the running
app a right-click on Mochi opened the wardrobe with its 13 tiles and "Auto ·
Witch hat", hovering tried the party hat on, and the witch hat showed on both
the Claude Code and Codex Mochis in the overview. Every outfit was also
rendered from the same engine code in headless Chromium (front, turned and
mid-roll). Not verified by hand: the ⌃⌥G shortcut (shortcuts are a later port)
and Mochi on the desktop (not ported).

### 17. Music, and Mochi dances (`windows-codex`, upstream #144, #153)

macOS reads Apple Music; Windows reads the session behind its own media
controls (the volume flyout's), so the **Music** pill follows Spotify, Apple
Music for Windows, a browser tab or any player listed there. It is off by
default, like the other pills (Settings → Integrations; at most four).

- [music.rs](../windows/src-tauri/src/music.rs) asks
  `GlobalSystemMediaTransportControlsSessionManager` every 1.5 s, only while the
  pill is on, for the current session's title, artist, album and whether it
  plays, tidies them as `MusicController` does ("Song (Radio Edit) - Live" →
  "Song", "Artist feat. X" → "Artist") and sends changes as a `music` event.
  `music_control` plays/pauses, skips or goes back on that session. The
  `windows` crate gains `Foundation` and `Media_Control`; the lock file does not
  change. Linux has no reader yet: the card says so.
- The pill is named after the song; on hover, play/pause and next slide in
  (clicks stay on the buttons). Focused, its card shows the title, the artist,
  and previous / play-pause / next.
- Mochi dances (a 112 BPM hop and sway, happy eyes when nothing else is going
  on) on the compact island and on the Music card, and the pill's mini Mochi
  dances while the song plays, as `BotCanvasView` and `MusicPill` decide on
  macOS. A song that starts while the island is hidden peeks it out without the
  peek sound.

Verified: `npm test` (64, four new in `tests/music.test.mjs`), `npx tsc
--noEmit`, `cargo test -p coucou --lib --locked` (55, two new; the native read is
`-- --ignored`), a release build. With a silent test track playing through
Windows' media controls, the native test read "One More Time (Radio Edit)" by
"Daft Punk feat. Romanthony" as "One More Time" by "Daft Punk", playing; in the
running app the pill appeared as "One More Time", Mochi danced on the compact
island (frames captured), the card showed the song and artist, and its Pause
button paused the session (the card then offered Play). The user's own pills
were restored afterwards. Not verified with Spotify or a browser by hand.

### 18. The GitHub pulse card (`windows-codex`, upstream #181, #185, #187)

The GitHub pill's card is now a pulse of your work, as on macOS. It uses the
same `github-token` in Credential Manager as the stats card it replaces (that
card still shows until the first pulse arrives).

- **My PRs**: your open pull requests, "3", "3 · running" or "3 · 1 failing"
  from their checks; the icon takes the worst CI colour. **To review**: pull
  requests waiting for your review. **Default branch CI**: the latest checks
  on the default branch of your recently pushed repositories (archived ones
  skipped): "all green", "running" or "2 failing".
- The header shows your stars and the last seven days of contributions. A
  click opens **Activity**: 23 weeks of the contribution calendar in GitHub's
  colours and the year's total; hovering a day shows its count, a click pins
  it, and the total opens your profile.
- Each stat opens its list: 20 px rows, three visible and the rest scrolling
  under a fade. A row opens the pull request, or the repository's Actions page,
  in the browser; only github.com links are opened.
- [github.rs](../windows/src-tauri/src/github.rs) ports `GitHubPulse.swift`,
  `GitHubActivity.swift` and the GitHub half of `GithubPoller.swift` with the
  same GraphQL queries. The pulse is fetched 10 s after start, then every 60 s
  while a check is running and every 5 min otherwise; the activity 15 s after
  start, then every 30 min. Both run only while the GitHub pill is on and
  Coucou is not paused. Opening the card refreshes data older than 60 s (the
  activity: 5 min); saving a new token clears both and fetches again.
- Alerts compare each poll with the previous one by head commit, so a CI that
  finishes between two polls still counts: a pull request's checks failing or
  passing, a default branch failing, a new review request. One badge and one
  sound per poll, by priority (red CI, then a review request, then green CI);
  the badge only when the GitHub card is not on screen, and it reveals the
  compact island. The first poll after launch never alerts.
- Differences from macOS: the lists use the Windows detail header (the back
  button of the other cards), and keyboard selection in the lists waits for the
  keyboard shortcuts port.

Verified: `npm test` (70, six new in `tests/github.test.mjs`: the card's
values, each list and its links, the fade, the 23-week grid with hover and pin,
the day labels, the alert priority and badge), `npx tsc --noEmit`, `cargo test
-p coucou --lib --locked` (59, four new: both queries parsed like the Mac, the
head-commit rules, staleness), a release build. With the user's own token in
the running app: the card showed 3 PRs, 0 to review, "unknown" for seven
repositories without checks, and the week; My PRs listed the three pull
requests; Default branch CI listed the seven repositories under the fade;
Activity drew 23 weeks with "115 past year · 13 repos" and a day's count on
hover. Nine rounds through the three lists and back kept the GitHub card in
focus. A long repository name pushed the title out of its row; a name now takes
at most 60% of the row before it truncates. Not verified: an alert from a real
CI change or review request (none happened during the test; the rules are
covered by the Rust and JavaScript tests). Twice during the first live run the
focus moved from the GitHub card to Codex or Claude Code with no hook event
logged; it did not recur in the traced runs or a 25 s watch with no input, and
the user was working at the time, so a click on the island is the likely cause,
but it is unconfirmed.

### 19. GitHub Copilot CLI and Muse Code (`windows-codex`, upstream #263)

Upstream added Copilot CLI and Muse Code (with OpenCode and Amp, whose plugin
installers are macOS-only). Its Windows README already listed the two, but
nothing on Windows handled them: the relay passed Copilot's camelCase events
through unchanged, and the island declined every approval that was not Claude
Code's or Codex's.

- The relay ([main.rs](../windows/hook/src/main.rs)) maps other agents' event
  names to Claude Code's as the macOS relay does (Copilot's camelCase, Muse's
  snake_case, Gemini CLI's and Antigravity's), and their fields: Copilot's
  `toolName`, `toolArgs` (an object, or a JSON string), `sessionId` and
  `workdir`, Gemini's `toolCall`. Copilot's `toolResult` is dropped, like
  Claude Code's `tool_response`.
- Copilot CLI, Muse Code, Gemini CLI and Antigravity read a JSON object from
  every hook, so they always get one: `{}` when there is no decision (Copilot
  treats anything else as a failed hook). An island decision reaches Copilot
  as `{"behavior":…,"permissionDecision":…}`: Copilot's current documentation
  reads `behavior` for `permissionRequest`, and Coucou on macOS sends
  `permissionDecision`, so both are sent. Muse gets `permissionDecision`, as on
  macOS. Claude Code and Codex are unchanged.
- The island: a **Copilot CLI** pill (#818CF8) and a **Muse Code** pill
  (#38BDF8), labelled "Agent" as in macOS's pill catalog. Their permission
  requests get the Allow / Deny card, with "Handled in Copilot CLI." or
  "Handled in Muse Code." when the agent moves on first. Other agents still
  go back to their own terminal.
- **Settings → Copilot CLI** ([copilot_hooks.rs](../windows/src-tauri/src/copilot_hooks.rs))
  installs `~/.copilot/hooks/coucou.json` (or under `$COPILOT_HOME`) with the
  Codex section's rules: the exact diff, a dated backup, a write only on
  click, foreign entries untouched, no write if the file changed since the
  preview. On Windows each entry is a `powershell` command (`& "…\coucou-hook.exe"
  --agent copilot <event>`): Copilot runs `powershell` entries on Windows and
  `bash` ones elsewhere, so upstream's bash-only entries would never run here.
  Removal takes Coucou's entries out and deletes the file when only its
  version is left. Backups do not end in `.json`, so Copilot never loads one
  as a second set of hooks. The Codex and Copilot sections share one
  implementation; Codex's texts are unchanged.
- Muse Code runs on macOS and Linux only (on Windows it needs WSL2), so there
  is no installer on Windows; the relay and the island handle `--agent muse`.
  The README's Windows path for Muse's settings was wrong and is replaced.

Verified: `npm test` (73, three new in `tests/hooks.test.mjs`), `npx tsc
--noEmit`, `cargo test -p coucou --lib --locked` (64, five new in
`copilot_hooks.rs`), `cargo test -p coucou-hook --locked` (16, seven new: the
argument parsing, the event and field mapping, the decision formats, `{}` for
JSON agents, Claude Code payloads untouched), release builds of both. Live,
with simulated payloads in Copilot's camelCase format through the installed
relay: `userPromptSubmitted` and `preToolUse` made a Copilot CLI pill with the
prompt and "bash · npm test" (the relay printed `{}` and exited 0);
`permissionRequest` showed "Copilot CLI needs permission · bash · git push fork
windows-codex", and Allow made the relay print
`{"behavior":"allow","permissionDecision":"allow"}`; a second request while
the first was waiting went straight back with `{}`; `agentStop` showed
"Copilot CLI finished" and the pill went away. The user installed the hooks
from Settings during the test: the app reports all eight events registered,
and the file's `sessionStart` command, run as written through `powershell
-Command` with the JSON piped in, reached Coucou and returned `{}` with exit
code 0. Not verified: a real Copilot CLI session (the CLI is not installed on
this machine; VS Code's Copilot Chat ships only a launcher that offers to
install it), whether Copilot runs `powershell` entries with `powershell.exe`
or `pwsh` (`pwsh` is not installed here), a live Deny (covered by the relay
and island tests), and Muse Code anywhere.

## Where the implementation lives

| File | Responsibility |
|---|---|
| [hooks.ts](../windows/src/island/hooks.ts) | Receives events and updates the island, badges, completion text, sounds, and each pill's working folder |
| [codex-sessions.ts](../windows/src/island/codex-sessions.ts) | Correlates sessions/turns and selects the activity shown by the shared Codex pill |
| [state.ts](../windows/src/core/state.ts) | Persistent pill, default focus, and task state |
| [views.ts](../windows/src/views/views.ts) | Activity ticker, finished-card actions, and agent-specific finished-card label |
| [island.ts](../windows/src/island/island.ts) | Terminal, VS Code, and ↗ routing; launch error note |
| [launch.rs](../windows/src-tauri/src/launch.rs) and [lib.rs](../windows/src-tauri/src/lib.rs) | Folder validation, Windows Terminal/PowerShell, VS Code and Claude Code hand-off launchers, Tauri commands |
| [codex_cli.rs](../windows/src-tauri/src/codex_cli.rs) | Codex's Mochi on the ChatGPT plan through `codex exec` |
| [claude_cli.rs](../windows/src-tauri/src/claude_cli.rs) | Claude's Mochi on the Claude plan through `claude -p` |
| [codex_hooks.rs](../windows/src-tauri/src/codex_hooks.rs) | Codex hook status, install, repair, and removal |
| [claude.rs](../windows/src-tauri/src/claude.rs) | Claude's Mochi (Anthropic), shared conversation store and structured errors, connection test |
| [openai.rs](../windows/src-tauri/src/openai.rs) | Codex's Mochi (OpenAI Responses API), error mapping, connection test |
| [secrets.rs](../windows/src-tauri/src/secrets.rs) | Credential read, save, and remove with verification |
| [chat.ts](../windows/src/views/chat.ts) | Chat per Mochi, errors, retry, and the Chat settings action |
| [settings](../windows/src/settings/main.ts) and [hook installer](../windows/src-tauri/src/hooks.rs) | Settings window (hooks for both agents, both Mochis' sign-in and connection test) and Claude Code hook installation |
| [pipe.rs](../windows/src-tauri/src/pipe.rs) and [relay](../windows/hook/src/main.rs) | Native transport and hook forwarding |
| [plan_usage.rs](../windows/src-tauri/src/plan_usage.rs), [statusline.rs](../windows/hook/src/statusline.rs), [plan.ts](../windows/src/core/plan.ts) | Plan usage for both cards: Claude Code's status line, `rate_limit_event` and installer; Codex's app server and logs; gauges and plan card |
| [netspeed.rs](../windows/src-tauri/src/netspeed.rs), [net.ts](../windows/src/core/net.ts) | Internet speed in the header |
| [plan-usage.test.mjs](../windows/tests/plan-usage.test.mjs) | 3 tests: gauge maths, internet speed in the header, usage lines and plan card on the Claude Code and Codex cards |
| [hooks.test.mjs](../windows/tests/hooks.test.mjs) | 25 lifecycle, routing, pill and approval tests |
| [codex-views.test.mjs](../windows/tests/codex-views.test.mjs) | 6 view tests: the Codex card, ticker, cards and settings badge |
| [phase1.test.mjs](../windows/tests/phase1.test.mjs) | 15 view tests: Phase 1, both Mochis and their sign-in choices, the Claude hand-off, and the Codex hooks section |

## What was verified

### Phase 1 (`windows-phase1`)

| Check | Where and when | Result |
|---|---|---|
| `npm test` | 3 October, handover review. The Windows checkout, run by Node 22.23.2 in a Linux VM with the checkout's own `node_modules` (TypeScript 5.9.3) | `3a8f2cd`: 22/22 pass. With the review fix: 23/23 pass (16 hook + 7 Phase 1) |
| `tsc --noEmit` | Same | Pass, at `3a8f2cd` and with the review fix |
| `git diff --check` | Same | Pass for the review changes |
| `cargo test -p coucou --lib --locked` | Reported for `3a8f2cd` by the previous session, on Windows | 13 pass; the 3 native `#[ignore]` tests were skipped. **Not re-run in the review:** that session had no Windows shell. The review changed no Rust code |
| Native `#[ignore]` tests | None | **Not run** |
| Running app | None | **Not done** for `3a8f2cd` |

The frontend suites execute the real TypeScript with mocked native calls,
sounds, DOM, and island window. They are platform-neutral: they check view and
state logic, not native launching or the Credential Manager.

### Codex lifecycle (`windows-codex`)

The implementation was checked on Windows on 2 October 2026. The then 15
regression tests were run again on 3 October and all passed.

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

A local 0.1.1 installer was produced from the lifecycle work. Fresh
installation, upgrade, and uninstall were not tested, and no signed release was
published. Linux and macOS builds were not validated for the Windows changes.

## Outstanding Phase 1 validation

Before merging `windows-phase1` into `windows-codex`, on Windows:

1. From `windows/`: `npm test`, `npx tsc --noEmit`, and
   `cargo test -p coucou --lib --locked`.
2. The native opt-in tests: `cargo test -p coucou --lib --locked -- --ignored`.
   They create and delete a test credential named
   `fr.louisraille.coucou.test.<number>`, create and delete temporary folders,
   start a hidden PowerShell process, and open a short-lived Terminal tab. They
   never read the real API key.
3. In the running app (`npm run tauri dev`, then the release build):
   - **Open terminal** from the Codex finished card and the ↗ button, with
     Windows Terminal closed and open, for a folder whose name contains spaces,
     non-ASCII characters, `&`, `%`, `;`, and `'`.
   - **Open in VS Code** with the folder already open, with another project
     open (review item 1), and with `code` missing from `PATH`.
   - A deleted working folder, and a pill that has no folder yet.
   - Chat with no key, an invalid key, and a valid key. **Chat settings** opens
     the chat section; **Retry** keeps the question and the dropped file.
   - Save, replace, remove, and **Test connection** in Settings. Confirm the
     Credential Manager entry, and that the key never appears in the UI or in
     `%LOCALAPPDATA%\Coucou\coucou.log`.
   - A non-Codex `coucou_agent` agent, to confirm the review fix end to end.
4. Installer: fresh install, upgrade from 0.1.1, and uninstall for the current
   commit.
5. A prolonged session with Claude Code and Codex running at the same time.

Items 4 and 5 also cover the Codex lifecycle work.

## Recommended next change

1. **Try a real approval that Codex asks the user about.** The hooks are
   repaired and trusted, and a real request was answered with Allow from the
   island on 4 October, but that chat used auto-review, which Coucou now leaves
   to Codex (section 12). Switch a Codex chat's approvals to the user, ask for
   something that needs approval, and answer from the island once with Allow
   and once with Deny; then confirm an auto-review chat runs without a card and
   **Open in Codex** lands on the finished chat.
2. **Finish the other live checks.** Ask Codex's Mochi a question, one needing
   web search, and one about a dropped image. Drop an image and a PDF on
   Claude's Mochi. Switch **Sign in with** by hand in Settings. Confirm a Claude
   Code session lights up the Claude Code pill next to a Codex session.
3. **Continue the upstream ports** in the order of
   [UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md): answering
   Claude questions (#165) next. (Claude plan usage, section 13, is done.)
4. ~~Merge `windows-codex-claude` into `windows-codex`~~ — **done** on
   5 October at the user's request, so Zack sees the working version:
   `windows-codex`, `windows-codex-claude` and `windows-plan-usage` all point
   at the same commit. New work branches from `windows-codex`.

## Next phases

### Phase 2 — Codex hook setup and diagnostics

**Implemented on `windows-codex-claude`** (section 8). Still open: the
"fresh Windows account" check below, and observing delivery after a write from
the real Settings window. The original plan follows.

Proposed work:

- Add a Codex Hooks section with installation status and delivery diagnostics,
  starting with the read-only slice above.
- Preview edits, take a dated backup, and preserve unrelated configuration. The
  Claude Code installer in `hooks.rs` (diff preview, fingerprint check, dated
  backup) is the model to follow.
- Generate valid PowerShell `commandWindows` entries and validate the relay path.
- Explain/check the applicable Codex trust step; do not silently approve trust.
- Make repeated installation, repair, and removal safe and predictable.

**Done when:** a fresh Windows account can configure hooks using the documented
flow, observe prompt/tool/Stop delivery, and remove only Coucou's entries.
Test absent files, existing unrelated hooks, malformed JSON, and failed writes.

### Phase 3 — Codex approvals

**Implemented on `windows-codex-claude`** (section 10). Still open: the live
check with a real Codex session. The original plan follows.

**Current gap:** external-agent `PermissionRequest` events are declined by
Coucou without a decision so the originating agent can handle them. Codex
therefore gets no Allow/Deny card. The tested Codex hook configuration does not
register this event.

Upstream has since shipped Codex approvals on macOS (#130): `PermissionRequest`
registered with a 120 s timeout and a `statusMessage`, answered with
`decision.behavior` `allow` or `deny`, and no "Always" (Codex rejects
`updatedPermissions`). Confirm that protocol against the installed Codex before
porting it; the mapping is in
[UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md).

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

These phases have no assigned owners or delivery dates yet.

## Collaborator workflow

Prerequisites: Node 20+, Rust, MSVC C++ build tools, and WebView2 as described in
the [Windows README](../windows/README.md#build-it-yourself).

```powershell
git clone --branch windows-phase1 https://github.com/kojos03/coucou.git
cd coucou/windows
npm install
npm test
npm run tauri dev
```

Use `windows-phase1` to review or validate Phase 1. For a release build, run
`npm run pack` from `windows/`. Before testing real Codex events, run Coucou and
verify that Codex has enabled, trusted hooks pointing to the installed relay.
Cloning does not copy the tested machine's configuration. The current log is
`%LOCALAPPDATA%\Coucou\coucou.log`.

For each change, keep the scope focused, document acceptance checks and
results, and open a pull request against `kojos03/coucou:windows-codex`. Until
Phase 1 is merged, branch new work from `windows-phase1`. Keep this status note
synchronized with completed work; move a planned item only after its checks pass.

Do not commit API keys, credential exports, personal `%USERPROFILE%\.codex`
files, raw session logs, `node_modules/`, `target/`, `dist/`, or installers.
Use sanitized examples for debugging and release assets for distributable builds.
