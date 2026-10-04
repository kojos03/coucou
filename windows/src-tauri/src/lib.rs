// Coucou for Windows — app wiring and the commands the island calls.

mod claude;
mod claude_cli;
mod codex_cli;
mod codex_hooks;
mod codex_review;
mod files;
mod hooks;
mod integrations;
mod island;
mod launch;
mod log;
mod openai;
mod pipe;
mod plan_usage;
mod platform;
mod secrets;
mod settings;
mod tray;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatError, ChatReply};
use codex_hooks::CodexHookStatus;
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

#[tauri::command]
fn open_in_vscode(path: Option<String>) -> Result<(), String> {
    launch::vscode(path.as_deref())
}

#[tauri::command]
fn open_terminal(path: Option<String>) -> Result<(), String> {
    launch::terminal(path.as_deref())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

/// The Claude plan pill: the latest numbers Claude Code's status line passed on.
#[tauri::command]
fn plan_usage_latest() -> Option<plan_usage::PlanUsage> {
    plan_usage::latest()
}

#[tauri::command]
fn plan_relay_status() -> plan_usage::PlanRelayStatus {
    plan_usage::status()
}

/// The diff of the `statusLine` change, before anything is written.
#[tauri::command]
fn plan_relay_preview(install: bool) -> Result<HookPreview, String> {
    plan_usage::preview(install)
}

/// Only ever called from an explicit click in the settings window. `show` turns
/// the pill on with the relay (the switch that asked for it); removing the relay
/// always turns it off.
#[tauri::command]
fn plan_relay_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
    show: Option<bool>,
) -> Result<String, String> {
    let backup = plan_usage::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        if !install {
            current.show_plan_usage = false;
        } else if let Some(show) = show {
            current.show_plan_usage = show;
        }
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    let _ = app.emit("plan-relay-changed", install);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// Which Mochi is chatting: Codex's answers through OpenAI, every other pill's
/// through Anthropic. The island picks it from the focused pill.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChatProvider {
    Anthropic,
    Openai,
}

/// One conversation per Mochi, so switching pills never mixes the two histories.
/// Each Mochi keeps one per sign-in method, since their formats differ.
#[derive(Default)]
struct Chats {
    anthropic: Chat,
    claude_code: Chat,
    openai: Chat,
    codex: Chat,
}

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chats: State<'_, Chats>,
    provider: ChatProvider,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, ChatError> {
    let (model, openai_model, claude_sign_in, codex_sign_in) = {
        let settings = shared.settings.lock().unwrap();
        (
            settings.model.clone(),
            settings.openai_model.clone(),
            settings.anthropic_auth != "apiKey",
            settings.openai_auth != "apiKey",
        )
    };
    match provider {
        ChatProvider::Anthropic if claude_sign_in => claude_cli::send(&chats.claude_code, query, context).await,
        ChatProvider::Anthropic => claude::send(&chats.anthropic, &model, query, context).await,
        ChatProvider::Openai if codex_sign_in => codex_cli::send(&chats.codex, query, context).await,
        ChatProvider::Openai => openai::send(&chats.openai, &openai_model, query, context).await,
    }
}

/// A dropped file starts a new conversation with both Mochis.
#[tauri::command]
fn chat_reset(chats: State<Chats>) {
    chats.anthropic.reset();
    chats.claude_code.reset();
    chats.openai.reset();
    chats.codex.reset();
}

/// Checks the saved key and model, or that Claude Code or Codex is signed in.
/// Sends no message.
#[tauri::command]
async fn chat_test_connection(
    shared: State<'_, Shared>,
    provider: ChatProvider,
    model: String,
) -> Result<(), ChatError> {
    let (claude_sign_in, codex_sign_in) = {
        let settings = shared.settings.lock().unwrap();
        (settings.anthropic_auth != "apiKey", settings.openai_auth != "apiKey")
    };
    match provider {
        ChatProvider::Anthropic if claude_sign_in => claude_cli::test_connection().await,
        ChatProvider::Anthropic => claude::test_connection(&model).await,
        ChatProvider::Openai if codex_sign_in => codex_cli::test_connection().await,
        ChatProvider::Openai => openai::test_connection(&model).await,
    }
}

/// "Ask in Claude Code": the question opens in the official Claude Code, which
/// runs on the user's own Claude sign-in.
#[tauri::command]
fn open_claude_code(question: String) -> Result<(), String> {
    launch::claude_code(&question)
}

/// "Open Codex" on the Codex card: the Codex desktop app, when installed.
/// "Open in Codex" on the finished card passes the chat's thread id.
#[tauri::command]
fn open_codex(thread: Option<String>) -> Result<(), String> {
    match thread {
        Some(thread) => launch::codex_thread(&thread),
        None => launch::codex_app(),
    }
}

#[tauri::command]
fn codex_app_installed() -> bool {
    launch::codex_app_installed()
}

/// "Open Claude app" on the Claude Code card: the Claude desktop app.
#[tauri::command]
fn open_claude_app() -> Result<(), String> {
    launch::claude_app()
}

#[tauri::command]
fn vscode_installed() -> bool {
    launch::vscode_installed()
}

#[tauri::command]
fn codex_hooks_status() -> CodexHookStatus {
    codex_hooks::status()
}

/// Diff to show before anything is written to ~/.codex/hooks.json.
#[tauri::command]
fn codex_hooks_preview(install: bool) -> Result<HookPreview, String> {
    codex_hooks::preview(install)
}

/// Writes ~/.codex/hooks.json — only after an explicit click, and only when the
/// file still matches the preview the user looked at.
#[tauri::command]
fn codex_hooks_apply(app: AppHandle, install: bool, fingerprint: String) -> Result<String, String> {
    let backup = codex_hooks::write(install, &fingerprint)?;
    // The island's Codex card says whether the hooks are in place.
    let _ = app.emit_to(island::WINDOW_LABEL, "codex-hooks-changed", ());
    Ok(backup)
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> Result<bool, String> {
    secrets::read(&key).map(|value| value.is_some())
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle, section: Option<String>) {
    show_settings_window(&app);
    if let Some(target @ ("claude" | "openai" | "codex")) = section.as_deref() {
        let _ = app.emit_to("settings", "settings-section", target);
    }
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chats::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            open_terminal,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            plan_usage_latest,
            plan_relay_status,
            plan_relay_preview,
            plan_relay_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            chat_test_connection,
            open_claude_code,
            open_codex,
            codex_app_installed,
            open_claude_app,
            vscode_installed,
            codex_hooks_status,
            codex_hooks_preview,
            codex_hooks_apply,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
