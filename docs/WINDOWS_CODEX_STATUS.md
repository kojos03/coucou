# Windows Codex integration: progress and next phases

Last updated: 3 October 2026, late evening: Claude's Mochi now chats on the
user's Claude plan through Claude Code, confirmed live in the island (section 9);
the upstream review is in [UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md).

This is the engineering handoff for Konstantinos and Zack on the
[kojos03/coucou fork](https://github.com/kojos03/coucou). The Windows work is
split across these branches; the fork's `main` branch is a separate line of
development.

| Branch | Contents | State |
|---|---|---|
| `windows-codex` | [ee6176f — Fix Windows Codex activity and completion lifecycle](https://github.com/kojos03/coucou/commit/ee6176f7c42103de18d298d3a90969097204665f) | Pushed; integration baseline |
| `windows-codex-documentation` | [2967bb8 — Document Windows Codex progress and next phases](https://github.com/kojos03/coucou/commit/2967bb80ad60e8e7dbeb6d64ebad011ecb4ec047), on top of `ee6176f` | Pushed |
| `windows-phase1` | [3a8f2cd — Fix Windows launch actions and Mochi chat setup](https://github.com/kojos03/coucou/commit/3a8f2cdea98b3e1d9cc50349b6a94e9dd9ac6b50) and `c95d7ee` (review fix and this note), on top of `2967bb8` | Pushed; not merged into `windows-codex` or `main` |
| `windows-codex-claude` | **Main working version.** Two Mochis and chats (section 7), subscriptions, Codex hook setup and named pills (section 8), Claude's Mochi on the Claude plan (section 9), on top of `windows-phase1` | Pushed; not merged |

**Current status:** `windows-codex-claude` is the main working version. It
passes every automated check natively on Windows, including the opt-in native
tests, and the release build runs on the development machine. Claude's Mochi
answered live in the island on the user's Claude Pro plan, with web search and a
follow-up turn (section 9). Not yet confirmed: a live reply from Codex's Mochi
(the ChatGPT plan's Codex usage limit runs until 4 October), file drops on
either plan, and a prolonged Claude Code + Codex session. Phase 2 is implemented
on this branch; Phases 3 and 4 are proposed work, and the upstream features to
port are planned in [UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md).

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
| [hooks.test.mjs](../windows/tests/hooks.test.mjs) | 17 lifecycle, routing and pill tests |
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

1. **Finish the live checks on the main working version.** After the Codex
   usage limit resets (4 October), ask Codex's Mochi a question, one needing
   web search, and one about a dropped image. Drop an image and a PDF on
   Claude's Mochi. Switch **Sign in with** by hand in Settings. Claude Code is
   now signed in and its hooks are installed: confirm a Claude Code session
   lights up the Claude Code pill next to a Codex session.
2. **Merge upstream `main`** (no conflicts, macOS-only changes) so the fork
   follows upstream's rules and docs, then port features in the order of
   [UPSTREAM_INTEGRATION_PLAN.md](UPSTREAM_INTEGRATION_PLAN.md), starting with
   Codex approvals (Phase 3), whose protocol upstream has now settled.
3. **Decide review items 1–3 and merge** `windows-codex-claude` (which
   contains `windows-phase1`) into `windows-codex` once the checks above pass.

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
