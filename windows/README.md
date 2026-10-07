<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou for Windows

**Mochi doesn't get a notch on a PC — so it lives at the top of your screen instead.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![Code: MIT](https://img.shields.io/badge/code-MIT-green)

</div>

## Windows Codex fork

The `windows-codex` branch of [kojos03/coucou](https://github.com/kojos03/coucou/tree/windows-codex)
is the latest working version of the Windows app. See the
[progress report and next phases](../docs/WINDOWS_CODEX_STATUS.md) for completed
changes, verification results, known limitations, and the collaborator workflow.
It brings together Phase 1 (separate terminal and VS Code actions, chat setup
errors, and a connection test), two Mochis — Claude Code and Codex, each with its
own pill and chat, on your Claude and ChatGPT plans — Codex hook setup and
approvals from the island, plan usage on both cards, and the internet speed in
the header, with upstream Coucou 0.1.8 merged.

<img src="screenshots/greeting.png" width="640" alt="Mochi waving hello at launch">

---

## Install

The downloadable installer is **temporarily unavailable**. Microsoft Defender
wrongly flags the unsigned installer as malware (`Trojan:Win32/Wacatac.H!ml`, a
machine-learning false positive). A report is under review at Microsoft, and the
installer will be published again once it is cleared and code-signed.

Until then, [build it yourself](#build-it-yourself): it takes a few minutes and
installs for the current user only — no admin prompt.

## Using it

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Mochis">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with Claude from the island">
<img src="screenshots/drop.png" width="640" alt="Mochi turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Mochi peeks out |
| Click the small island | It opens |
| Click Mochi | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Mochi for two seconds | Hearts |
| Turn on the **Music** pill (Settings → Integrations) | The pill names the song playing in any player Windows shows in its media controls (Spotify, Apple Music, a browser tab…), with play/pause and next on hover; its card adds the artist and previous. Mochi dances along on the small island and on the Music card |
| Turn on the **GitHub** pill with a token | Its card shows your open pull requests and their checks, the pull requests waiting for your review, your default branches' CI, your stars and the last week of contributions. Click a line for its list (a row opens on GitHub), or the week for 23 weeks of activity. A failing or passing check, or a new review request, badges the pill |
| Right-click Mochi | His wardrobe: hover an outfit to try it on, click to keep it. **Auto** follows the seasons (a witch hat in October, a Santa hat in December…) |
| Drag a file onto the island | Mochi turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and
your integrations sit in the coloured pills next to Mochi.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Coucou's entries.

The relay is a tiny executable, `coucou-hook.exe`, copied to
`%LOCALAPPDATA%\Coucou\bin\` at launch. It is given 300 ms to reach Coucou and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Coucou.** If nobody answers a permission request
in time, Coucou stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

The **Claude Code** pill is Claude orange. With no session running, its card
shows whether the hooks are installed and **Open Claude app**, which starts the
Claude desktop app (the Microsoft Store version, or the older per-user install).

**VS Code** is its own purple pill: switch it on in **Settings… →
Integrations** (it counts towards the four integrations shown next to Mochi).
Its card says whether VS Code's `code` launcher is installed and offers **Open
Visual Studio Code**.

### Plan usage and internet speed

The **Claude Code** card shows how much of your Claude plan's 5-hour and weekly
limits you have used, under *Connected* (`5h ▬ 62%  week ▬ 35%`; at a limit,
*Weekly limit reached · resets Fri 9:00*). Click it for the reset times. It is
one pool for Claude Code, Cowork and the Claude apps, so the same line covers
all of them. While the card is open, Coucou asks Claude Code for the numbers when
they are more than ten minutes old: one tiny request (Haiku, about 400 tokens),
and **Refresh** asks at once. Chats with Claude's Mochi bring them along for
free. Coucou never reads your Claude sign-in.

Optionally, **Settings… → Claude plan usage → Install status line…** adds a
status line to `%USERPROFILE%\.claude\settings.json` (the `statusLine` key
only, with the same diff, dated backup and click as the hooks): Claude Code then
passes the numbers on after each reply in a terminal, at no cost, and prints
them on its status line (`5h 23% · week 41%`). A status line you already had
keeps running in its place, and **Remove status line…** puts it back exactly.
Like the hooks, it expects Claude Code to run commands through Git Bash.

The **Codex** card shows the same line for your ChatGPT plan's Codex limits,
straight from Codex (`codex app-server`, the read the Codex app makes for its
own usage view — no model call): at launch, after each Codex turn, and while the
card is open (at most once a minute). Without the Codex CLI, it falls back to the
numbers Codex writes in its session logs.

The island's header shows your internet speed right now — `↓ 18 Mbps ↑ 1.1 Mbps`
— from your network adapters' own counters, once a second while the island is
on screen. Nothing is downloaded to measure it.

## Codex

Open **Settings… → Codex**. It shows whether `%USERPROFILE%\.codex\hooks.json`
registers Coucou for every event the island follows, which entries are missing
or need repair, and when Codex last reached Coucou. **Install hooks…** or
**Repair hooks…** shows the exact diff and the dated backup first, writes only
when you click, leaves your own hooks alone, and never rewrites an entry that is
already correct. After a change, Codex asks you to review the hooks: run `/hooks`
in Codex and trust them. **Remove hooks…** takes out Coucou's entries only.

The Codex pill then works like Claude Code's. While a chat runs, the ticker
shows **Codex** with the project folder and each step; a finished turn opens
**Codex finished** with **Open in Codex** (that chat in the Codex app, when it is
installed; **Open terminal** otherwise) and **Open in VS Code**, then settles
back to idle. When Codex asks you for permission, the island shows the command or
the files of a patch with **Deny** and **Allow** (there is no "Always": Codex
doesn't accept one). Codex shows *Waiting for your answer in Coucou* meanwhile.
If nobody clicks within 110 seconds, or Codex stops waiting first, the card goes
away and Codex asks you itself. Chats whose approvals go to Codex's auto-review
(the Codex app's default) are left to it: the island only asks when Codex would
ask you. With no chat running, the pill shows whether the
hooks are installed and **Open Codex** when the Codex app is installed.

## GitHub Copilot CLI

Open **Settings… → Copilot CLI**. **Install hooks…** writes Coucou's own file,
`%USERPROFILE%\.copilot\hooks\coucou.json` (Copilot reads every file in that
folder), after showing the exact diff and the dated backup; **Remove hooks…**
takes Coucou's entries out and deletes the file when nothing else is left in it.
On Windows the entries are PowerShell commands, as Copilot runs them there.

A Copilot session then gets a **Copilot CLI** pill (indigo) with its prompt and
each step, and goes away a few seconds after the turn ends, like other agents'
pills. When Copilot asks for permission, the island shows **Deny** and **Allow**;
if nobody clicks within 110 seconds, Copilot asks you itself.

Muse Code (Meta) runs on macOS and Linux only; on Windows it needs WSL2, which
Coucou does not reach. The relay and the island understand its events
(`--agent muse`: a **Muse Code** pill, with Allow and Deny), but there is no
installer here.

## Chat and keys

Coucou has two Mochis, shown as the **Claude Code** and **Codex** pills. The
focused pill decides which one you chat with: with the Codex pill focused, Mochi
is Codex light blue and answers through **OpenAI**; with any other pill, it is
Claude orange and answers through **Anthropic**. Each Mochi keeps its own conversation, and
dropping a file starts a new one with both.

**Codex's Mochi** signs in one of two ways (**Settings… → Codex's Mochi ·
OpenAI**):

- **ChatGPT plan (Codex sign-in)**, the default: Coucou runs the official
  Codex CLI you are signed in to (`codex exec`), read-only, with hooks off and
  without adding the chat to your Codex history. Replies count against your
  plan's Codex usage. Coucou never sees your sign-in. **Test connection** checks
  `codex login status`.
- **OpenAI API key**: Coucou calls the OpenAI API with the key and model you
  choose. Requests set `store: false`; OpenAI's own data retention policy still
  applies.

**Claude's Mochi** also signs in one of two ways (**Settings… → Claude's Mochi ·
Anthropic**):

- **Claude plan (Claude Code sign-in)**, the default: Coucou runs the official,
  unmodified Claude Code you are signed in to (`claude -p`) in its restricted
  mode. It can only search the web, read web pages and read a file you dropped;
  hooks, plugins and MCP servers are off, and the chat is not saved to your
  Claude Code history. Replies count against your Claude plan's usage. Coucou
  never sees your sign-in. **Test connection** checks `claude auth status`.
- **Anthropic API key**: Coucou calls the Anthropic API with the key and model
  you choose. Without a key, the chat offers **Ask in Claude Code**: your
  question opens in the official Claude Code in Windows Terminal.

On a plan, both Mochis use the model their CLI picks for your plan, and the
Model setting applies only to API keys. Anthropic and OpenAI set the terms and
limits for using a plan this way and may change them.

Keys live in the **Windows Credential Manager**, never on disk and never in the
interface — the island can only ask whether a key exists. Same for every
integration key. With a key, **Test connection** checks that it can see the
selected model without sending a message; it does not check billing or a full
chat reply.

No telemetry. The only network requests Coucou makes are to the services you
configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see. Neither page ships in the app.

`npm run pack` leaves two files in `windows/release/`, the same names the release
workflow publishes:

```
Coucou-Windows-X.Y.Z-setup.exe    the versioned installer
Coucou-Windows-setup.exe          the same file under the rolling name
```

Installing is optional — `target/release/coucou.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Mochi in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are the macOS app's own files; they are never duplicated in this
folder. The path is declared once, in `SOUNDS_DIR` at the top of
`vite.config.ts` — when they move to `shared/sounds/`, change that one line.

The app icon and the tray icon are drawn in code, like Mochi itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    mochi/             Mochi and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                coucou-hook.exe, the Claude Code relay
  scripts/             icon generator
```

### Log

`%LOCALAPPDATA%\Coucou\coucou.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## Supported agents

The relay (`coucou-hook.exe`) works with any tool that can run a command on hook events. Pass `--agent <name>` to create a named pill.

| Agent | How to connect | Config file |
|---|---|---|
| Claude Code | **Settings → Claude Code → Install hooks** | `%USERPROFILE%\.claude\settings.json` |
| Gemini CLI | `--agent gemini` positional arg | `%USERPROFILE%\.gemini\settings.json` |
| Antigravity | `--agent antigravity` positional arg | `%USERPROFILE%\.config\antigravity\hooks.json` |
| Cursor | hooks installed automatically | `%USERPROFILE%\.claude\settings.json` |
| Codex | `--agent codex` positional arg | `%USERPROFILE%\.codex\hooks.json` |
| Copilot CLI | **Settings → Copilot CLI → Install hooks** (`--agent copilot`, camelCase events) | `%USERPROFILE%\.copilot\hooks\coucou.json` |
| Muse Code | macOS and Linux only (Windows needs WSL2); `--agent muse` by hand, no installer here | `~/.config/muse/settings.json` |
| Any other | `--agent <name>` positional arg | your tool's hook config |

OpenCode and Amp are not yet supported on Windows or Linux. Their integration uses a plugin that calls `/bin/sh` with macOS-specific paths; the plugin installer lives in the Mac app only.

## What's different from the Mac version

- No notch, so the island lives at the top centre of the screen and retracts into
  the top edge instead of hiding in a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- Not in this version: sending a file by email, dragging Mochi onto a window to
  attach it as context, and jumping to a specific terminal window. **Open
  terminal** opens a new Windows Terminal tab (or a Windows PowerShell window)
  in the working folder; **Open in VS Code** opens it in VS Code when `code` is
  on your `PATH`.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.

## Linux

The same app builds for Linux: everything that differs lives in
`src-tauri/src/platform/`, and the relay's transport in `hook/src/unix.rs`.

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # AppImage, .deb and .rpm in windows/release/
```

What changes on Linux:

- **The island** is a gtk-layer-shell overlay anchored to the top edge, over any
  top panel, on compositors that support it: COSMIC, KDE Plasma, Hyprland, Sway
  and other wlroots compositors. GNOME has no layer-shell, so there the island
  is a regular window. `COUCOU_LAYER_SHELL=0` forces that mode anywhere.
- **Click-through** is the window's input region, kept equal to the island
  shape, so the compositor sends every other click to what is underneath.
- **Mochi's eyes** follow the pointer only while it is over the island: Wayland
  gives no app the cursor position anywhere else.
- **Claude Code hooks** go through `~/.local/share/coucou/bin/coucou-hook` and a
  Unix socket at `$XDG_RUNTIME_DIR/coucou.sock`. Both ends check that the other
  runs as the same user.
- **Keys** live in the Secret Service (GNOME Keyring, KWallet).
- **Files**: preferences in `~/.config/coucou/`, the log at
  `~/.local/share/coucou/coucou.log`.
- What the Windows build leaves out, this one does too: sending a file by
  email, dragging Mochi onto a window, and jumping to a specific terminal
  window. **Open terminal** is Windows-only for now and shows a message pointing
  to **Open in VS Code**, which opens the folder in VS Code.
