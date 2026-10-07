// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type GitHubActivity, type GitHubEvent, type GitHubPulse } from "../core/state";
import type { Island } from "./island";

/** Which Credential Manager key backs each pill. */
const KEY_FOR: Record<string, string> = {
  integration_stripe: "stripe-api-key",
  integration_github: "github-token",
  integration_vercel: "vercel-token",
  integration_n8n: "n8n-api-key",
  integration_resend: "resend-api-key",
  integration_notion: "notion-api-key",
  integration_calcom: "calcom-api-key",
};

const clearTimers = new Map<string, number>();

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void onEvent<{ pulse: GitHubPulse | null; events: GitHubEvent[] }>("github-pulse", ({ pulse, events }) => {
    State.githubPulse = pulse;
    if (!State.paused && State.settings.activeIntegrations.includes("integration_github")) {
      // Like the other pills here: show the compact island so the badge is seen.
      gitHubAlert(events, () => island.reveal());
    }
    State.notify();
  });
  void onEvent<GitHubActivity | null>("github-activity", (activity) => {
    State.githubActivity = activity;
    State.notify();
  });
  void Bridge.githubLatest().then((latest) => {
    State.githubPulse ??= latest?.pulse ?? null;
    State.githubActivity ??= latest?.activity ?? null;
    State.notify();
  });
  // Settings installed, repaired or removed the Codex hooks.
  void onEvent<null>("codex-hooks-changed", () => void refreshCodexHooks());
  void refreshConfigured();
}

/**
 * AppState.handleGitHubEvents: one badge and one sound for the lot, by priority
 * (a red CI over a review request over a green CI). The badge only when the
 * GitHub pill is not the one on screen.
 */
export function gitHubAlert(events: GitHubEvent[], onBadge?: (badge: "error" | "finished") => void) {
  let level = 0;
  let badge: "error" | "finished" | null = null;
  let sound: string | null = null;
  for (const e of events) {
    if ((e.kind === "ciFailed" || e.kind === "mainFailed") && level < 3) {
      level = 3; badge = "error"; sound = "error";
    } else if (e.kind === "reviewRequested" && level < 2) {
      level = 2; badge = "finished"; sound = "question";
    } else if (e.kind === "ciPassed" && level < 1) {
      level = 1; badge = "finished"; sound = "finish";
    }
  }
  if (badge && State.focusId !== "integration_github") {
    State.setPillBadge("integration_github", badge);
    onBadge?.(badge);
  }
  if (sound) Sound.play(sound);
}

/** What the Codex card shows: whether the hooks are in place, and the app. */
export async function refreshCodexHooks() {
  const [status, app] = await Promise.all([
    Bridge.codexHooksStatus().catch(() => null),
    Bridge.codexAppInstalled().catch(() => null),
  ]);
  State.integrations.agent_codex = {
    data: { anyInstalled: status?.anyInstalled ?? false, app: app === true },
    error: status?.problem ?? null,
    loaded: false,
    configured: status?.installed ?? false,
  };
  State.notify();
}

/** Asks Rust which keys exist so the idle cards can say so. */
export async function refreshConfigured() {
  for (const [id, key] of Object.entries(KEY_FOR)) {
    const present = await Bridge.secretPresent(key).catch(() => false);
    const info = State.integrations[id] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[id] = { ...info, configured: present };
  }
  const hooks = State.settings.hooksInstalled;
  const claude = State.integrations.integration_claude ?? {
    data: {}, error: null, loaded: false, configured: false,
  };
  State.integrations.integration_claude = { ...claude, configured: hooks };
  const vscode = await Bridge.vscodeInstalled().catch(() => null);
  State.integrations.integration_vscode = { data: {}, error: null, loaded: false, configured: vscode === true };
  // Music needs no key: Windows' media controls are always there (not on Linux yet).
  State.integrations.integration_music = {
    data: {}, error: null, loaded: true, configured: /Windows/.test(navigator.userAgent),
  };
  State.notify();
  await refreshCodexHooks();
}

function handle(island: Island, update: IntegrationUpdate) {
  if (State.paused) return;

  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data: update.error ? (previous?.data ?? {}) : update.data,
    error: update.error,
    loaded: update.error ? (previous?.loaded ?? false) : true,
    configured: previous?.configured ?? true,
  };

  const event = update.event;
  if (event) {
    const task = State.tasks.find((t) => t.id === update.id);
    if (task) {
      task.state = event.success ? "finished" : "error";
      task.steps = event.detail ? [event.label, event.detail] : [event.label];
      task.stepIndex = task.steps.length - 1;
      if (State.focusId !== update.id) {
        task.pillBadge = event.success ? "finished" : "error";
      }
      Sound.play(event.success ? "finish" : "error");
      // Same as the Swift pollers: show the compact island so the badge is seen,
      // but never steal the screen for a successful deploy.
      island.reveal();

      const existing = clearTimers.get(update.id);
      if (existing != null) window.clearTimeout(existing);
      clearTimers.set(
        update.id,
        window.setTimeout(() => {
          clearTimers.delete(update.id);
          const t = State.tasks.find((x) => x.id === update.id);
          if (!t || (t.state !== "finished" && t.state !== "error")) return;
          t.state = "idle";
          t.steps = [];
          t.stepIndex = 0;
          t.pillBadge = null;
          State.notify();
        }, 60_000),
      );
    }
  }

  State.notify();
}
