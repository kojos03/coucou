# Upstream integration plan

Last checked: 3 October 2026, against
[Louis-CFM/coucou](https://github.com/Louis-CFM/coucou) `main` at
`35886ec` (Coucou 0.1.4 for macOS). The fork's main working version is
`windows-codex-claude`; its common ancestor with upstream `main` is `5332f9e`.

**Merged 5 October 2026:** upstream `main` up to `30edad4` (Coucou 0.1.8 and
the iPhone app 1.0), 22 commits past `35886ec`, came in through
`windows-codex`, where a collaborator had merged it with the documentation pull
request (#1): `af36385` on `windows-codex-claude`, `1a6fccb` on
`windows-plan-usage`, both without conflicts. They are macOS and iPhone work —
Mochi's wardrobe (#195), greeting v2 (#196), Mochi on the desktop (#198),
keyboard shortcuts (#205), the iPhone app, widgets, Dynamic Island and
approvals from the iPhone (#209–#241), the `relay/` Cloudflare Worker for its
pushes, releases 0.1.5–0.1.8 — plus one Windows change, an MSI installer target
next to NSIS (#204: `tauri.conf.json` and `scripts/pack.mjs`). None of them
changes #159 or the Windows app's code.

## What upstream has added

Upstream `main` has **17 commits** since the fork's base, all from 2–3 October.
**None of them touch `windows/`**: every feature is macOS (Swift) code, plus
docs, tests, CI and release scripts. Bringing a feature to the fork therefore
means *porting* it to the Tauri app, not merging code.

| Upstream change | What it does on macOS | Port to Windows? |
|---|---|---|
| [#130](https://github.com/Louis-CFM/coucou/pull/130) Codex: live sessions and approvals | Codex permission requests get Allow/Deny in the notch; installer for `~/.codex/hooks.json` | **Yes — first.** This is the fork's Phase 3, and upstream has settled the protocol |
| [#159](https://github.com/Louis-CFM/coucou/pull/159) Claude plan usage | 5-hour and weekly Claude plan gauges, read from Claude Code's statusline `rate_limits` | **Yes.** Policy-safe way to show subscription usage |
| [#165](https://github.com/Louis-CFM/coucou/pull/165) Answer Claude questions | `AskUserQuestion` answered from the notch through a `PreToolUse` hook with `updatedInput` | Yes |
| [#177](https://github.com/Louis-CFM/coucou/pull/177) + [#179](https://github.com/Louis-CFM/coucou/pull/179) Live diff | Edit/MultiEdit/Write changes shown as diffs in the ticker; finished card kept unchanged | Yes |
| [#181](https://github.com/Louis-CFM/coucou/pull/181), [#185](https://github.com/Louis-CFM/coucou/pull/185), [#187](https://github.com/Louis-CFM/coucou/pull/187) GitHub pulse | Open PRs, CI and review requests (one GraphQL query, adaptive polling), SHA-aware alerts, contribution grid | Yes, into the existing GitHub poller |
| [#156](https://github.com/Louis-CFM/coucou/pull/156) Local models + Markdown | Chat with Ollama and LM Studio (OpenAI-compatible streaming); Markdown in replies | Yes, as a third chat option; Markdown separately |
| [#154](https://github.com/Louis-CFM/coucou/pull/154) Greet by first name | The chat system prompt names the account holder | Yes, small |
| [#144](https://github.com/Louis-CFM/coucou/pull/144), [#153](https://github.com/Louis-CFM/coucou/pull/153) Apple Music, Settings sidebar | Now-playing controls; Settings redesigned as a sidebar | No. Apple Music is macOS-only (a Windows media-session version would be new work); the sidebar would restyle shipped Windows Settings |
| [#134](https://github.com/Louis-CFM/coucou/pull/134), [#169](https://github.com/Louis-CFM/coucou/pull/169), [#188](https://github.com/Louis-CFM/coucou/pull/188), `ae38520` Releases 0.1.2–0.1.4 | macOS versions and changelog | Merge the docs only; Windows keeps its own version |
| [#135](https://github.com/Louis-CFM/coucou/pull/135) Site | Codex and Cursor on the home page | Merge as is |

Upstream branches that are not on `main`:

| Branch | Contents | Action |
|---|---|---|
| `n22-gemini` | **Windows** Gemini CLI and Antigravity hooks: relay event mapping, two installers, Settings sections (3 commits, 1 Oct) | Port after the Codex work; see conflicts below |
| `linux-0.1.2` | Linux AppImage built on Ubuntu 24.04, checksums, publish on tag | Take when the fork ships Linux builds |
| `windows`, `windows-0.1.1`, `windows-downloads`, `hold-windows-downloads` | Older Windows release and site work, already in `main` (except one site commit) | Nothing to do |

## Trial merges

Both were run in a scratch copy, not on the fork:

- **Upstream `main` into `windows-codex-claude`: no conflicts.** 51 files change,
  none under `windows/`. Safe to merge first so the fork follows upstream docs,
  tests and rules (for example the updated `CLAUDE.md` rule: never approve a
  Claude Code *or Codex* permission without an explicit click).
- **`n22-gemini` on top: 8 files conflict (14 blocks)**: `CHANGELOG.md`,
  `README.md`, `docs/AGENTS.md`, `docs/support.html`, `windows/README.md`,
  `windows/src-tauri/src/hooks.rs`, `windows/src/core/bridge.ts`,
  `windows/src/settings/main.ts` (4 blocks). They are mostly two additions in
  the same place (Codex and Gemini sections side by side). Resolve by keeping
  both, then move the Gemini/Antigravity installers onto the shared helpers the
  fork already exposes in `hooks.rs` (diff, fingerprint, backup, atomic write).

## How the main ports map onto the Windows app

**1. Codex approvals (#130).** Upstream registers `PermissionRequest` in
`~/.codex/hooks.json` with a 120 s timeout and a `statusMessage` shown in Codex
while it waits, and answers with
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
(or `deny`). Codex rejects `updatedPermissions`, so "Always" becomes a plain
allow. The Windows relay already writes this exact shape, so the work is:

- `codex_hooks.rs`: add `PermissionRequest` (timeout 120, `statusMessage`).
  Writing it changes `hooks.json`, so Codex will ask the user to re-trust.
- `hooks.ts`: show the approval card on the Codex pill instead of declining;
  correlate by `session_id`/`turn_id`; keep the one-card-at-a-time rule and the
  108 s island timeout; never offer "Always".
- Tests: relay output for Codex, card routing, stale or concurrent requests.

**2. Claude plan usage (#159).** Claude Code passes `rate_limits.five_hour` and
`rate_limits.seven_day` to a statusline command. Port as a relay `--statusline`
mode that forwards the payload (and prints a short status line), a Settings
action that installs only the `statusLine` key in `~/.claude/settings.json` with
diff, backup and confirmation (keeping any previous statusline to restore), and
a plan pill/card. This uses Claude Code's own data, never the Claude sign-in.

**3. Answer Claude questions (#165).** A dedicated `PreToolUse` hook for
`AskUserQuestion` (relay `--ask` mode, ~130 s), a question card with options,
multi-select, "Other…", and "Reply in terminal", answered through
`updatedInput`. Needs the same never-block guarantees as approvals.

**4. Live diff (#177/#179).** Build diffs from `PostToolUse` Edit/MultiEdit/
Write inputs in the island (the line diff in `hooks.rs` is a model), cap size,
show `+N −M` steps in the ticker and a diff card on click. Keep the finished
card unchanged, as upstream decided in #179.

**5. GitHub pulse (#181/#185/#187).** Extend `integrations.rs`'s GitHub poller
with the GraphQL query (PRs, CI, reviews, head SHA), adaptive polling
(60 s/300 s), silent first poll, refresh on focus, and the contribution grid;
new GitHub cards in `views/integrations.ts`.

**6. Local models and Markdown (#156).** Add Ollama/LM Studio as a third
`ChatProvider` (OpenAI-compatible streaming, local URLs only). Markdown needs a
safe renderer in the island and a system-prompt change for every provider, so
treat it as its own change.

## Suggested order

1. ~~Merge upstream `main`~~ — **done** (`9fbe01a`, 3 October; again up to
   0.1.8 through `windows-codex`, `af36385`, 5 October).
2. ~~Codex approvals (#130)~~ — **done** on `windows-codex-claude`, with the
   Codex pill brought to parity with Claude Code's
   ([status, section 10](WINDOWS_CODEX_STATUS.md)). Live check with a real
   Codex session pending.
3. ~~Claude plan usage (#159)~~ — **done** on `windows-plan-usage`, a pull
   request into `windows-codex-claude`
   ([status, section 13](WINDOWS_CODEX_STATUS.md)). One deliberate difference:
   with no status line of the user's to keep, the relay prints the plan usage
   rather than nothing.
4. Answer Claude questions (#165), then live diff (#177/#179).
5. GitHub pulse (#181/#185/#187).
6. Gemini CLI and Antigravity (`n22-gemini`), resolving the 8 conflicts above.
7. Local models, then Markdown (#156); first-name greeting (#154) alongside.

Each port: one branch and pull request into `windows-codex-claude`, tests for
the new logic, `npm test`, `npx tsc --noEmit`, `cargo test -p coucou --lib
--locked` (plus `-- --ignored` where native code changed), a release build, and
a short manual check in the running app. Recheck upstream before each port;
these features are a day old and may still change.
