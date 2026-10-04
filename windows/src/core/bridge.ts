// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ChatProvider, Settings } from "./state";
import type { PlanUsage } from "./plan";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  openTerminal: (path: string | null) => callOrThrow<void>("open_terminal", { path }),
  openInVSCode: (path: string | null) => callOrThrow<void>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: (section?: SettingsSection) => call<void>("open_settings_window", { section: section ?? null }),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Claude plan usage (Claude Code's status line) ─────────────────────────
  /** The latest 5-hour and weekly numbers, kept across restarts. */
  planUsage: () => call<PlanUsage>("plan_usage_latest"),
  planRelayStatus: () => call<PlanRelayStatus>("plan_relay_status"),
  /** Diff of the `statusLine` change; nothing is written. */
  planRelayPreview: (install: boolean) => callOrThrow<HookPreview>("plan_relay_preview", { install }),
  /**
   * Writes the `statusLine` key — only after an explicit click, and only when
   * settings.json still matches the preview. `show` turns the pill on with it.
   */
  planRelayApply: (install: boolean, fingerprint: string, show: boolean | null = null) =>
    callOrThrow<string>("plan_relay_apply", { install, fingerprint, show }),

  // ── Codex hooks (~/.codex/hooks.json) ─────────────────────────────────────
  codexHooksStatus: () => call<CodexHookStatus>("codex_hooks_status"),
  codexHooksPreview: (install: boolean) => callOrThrow<HookPreview>("codex_hooks_preview", { install }),
  /** Returns the backup path, or "" when there was nothing to back up. */
  codexHooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("codex_hooks_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn with the given Mochi. The API key and any file bytes never leave Rust. */
  chatSend: (provider: ChatProvider, query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { provider, query, context }),
  /** Starts new conversations with both Mochis. */
  chatReset: () => call<void>("chat_reset"),
  chatTestConnection: (provider: ChatProvider, model: string) =>
    callOrThrow<void>("chat_test_connection", { provider, model }),
  /** Opens the official Claude Code with the question, on the user's own Claude sign-in. */
  openClaudeCode: (question: string) => callOrThrow<void>("open_claude_code", { question }),
  /** "Open Codex": the Codex desktop app. */
  /** The Codex app, at `thread` (a chat's id) when one is given. */
  openCodex: (thread: string | null = null) => callOrThrow<void>("open_codex", { thread }),
  codexAppInstalled: () => call<boolean>("codex_app_installed"),
  /** "Open Claude app": the Claude desktop app. */
  openClaudeApp: () => callOrThrow<void>("open_claude_app"),
  /** Whether VS Code's `code` launcher is on PATH, for the VS Code card. */
  vscodeInstalled: () => call<boolean>("vscode_installed"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => callOrThrow<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

/** Settings window sections that `openSettingsWindow` can scroll to. */
export type SettingsSection = "claude" | "openai" | "codex";

export function settingsSectionFor(provider: ChatProvider): SettingsSection {
  return provider === "openai" ? "openai" : "claude";
}

export interface ChatFailure {
  code: string;
  message: string;
  settings: boolean;
}

export function chatFailure(error: unknown): ChatFailure {
  if (error && typeof error === "object" && "message" in error &&
      typeof error.message === "string") {
    return {
      code: "code" in error && typeof error.code === "string" ? error.code : "unknown",
      message: error.message,
      settings: "settings" in error && error.settings === true,
    };
  }
  return { code: "unknown", message: typeof error === "string" ? error : "Could not complete the request. Try again.", settings: false };
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
  /** Unix seconds of the last Claude Code event since Coucou started. */
  lastEvent?: number | null;
}

export interface CodexHookStatus {
  path: string;
  exists: boolean;
  /** Why hooks.json cannot be used as it is (unreadable, invalid JSON…). */
  problem: string | null;
  hookPath: string;
  hookReady: boolean;
  events: { event: string; state: "ok" | "missing" | "outdated" }[];
  installed: boolean;
  anyInstalled: boolean;
  lastEvent: number | null;
}

export interface PlanRelayStatus {
  installed: boolean;
  settingsPath: string;
  hookReady: boolean;
  /** The user's own status line, which Coucou's keeps running. */
  kept: string | null;
  /** A status line that is not Coucou's, in settings.json now. */
  other: string | null;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
