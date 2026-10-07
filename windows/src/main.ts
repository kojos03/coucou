// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { reportError } from "./core/errors";
import { Sound } from "./core/sound";
import { MUSIC_ID, State, type NowPlaying, type Settings } from "./core/state";
import type { PlanUsage } from "./core/plan";
import { Recap } from "./core/recap";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { checkMondayRecap } from "./island/recap";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  // Script errors used to vanish; now each leaves one line in Coucou's log.
  window.addEventListener("error", (event) => reportError("script", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError("promise", event.reason));

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
      case "recap":
        setPaused(false);
        island.alert("recap");
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  // Plan usage for the Claude Code and Codex cards: the last numbers seen,
  // then every update (status line, Mochi's chats, Claude Code, Codex).
  await onEvent<PlanUsage>("plan-usage", (usage) => {
    State.planUsage = usage;
    State.notify();
  });
  await onEvent<PlanUsage>("codex-usage", (usage) => {
    State.codexUsage = usage;
    State.notify();
  });
  State.planUsage = (await Bridge.planUsage()) ?? State.planUsage;
  State.codexUsage = (await Bridge.codexUsage()) ?? State.codexUsage;

  // Internet speed in the header, once a second while the island is on screen.
  await onEvent<{ down: number; up: number }>("net-speed", (speed) => {
    State.netSpeed = speed;
    State.notify();
  });

  // The Music pill: what the player plays. Music starting peeks the island out,
  // quietly, as on macOS.
  const applyMusic = (now: NowPlaying | null) => {
    const wasPlaying = State.music?.playing === true;
    State.music = now;
    if (now?.playing && !wasPlaying && !State.paused && State.mode === "hidden" &&
        State.settings.activeIntegrations.includes(MUSIC_ID)) {
      island.revealQuietly();
    }
    State.notify();
  };
  await onEvent<NowPlaying | null>("music", applyMusic);
  State.music = (await Bridge.musicNow()) ?? null;

  // The weekly recap's history, before the first hook event can add to it.
  Recap.load(await Bridge.recapLoad());
  await onEvent<null>("recap-cleared", () => {
    Recap.clear();
    State.notify();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // Monday's recap card: after the greeting, then every quarter of an hour.
  window.setTimeout(() => checkMondayRecap(island), 12_000);
  window.setInterval(() => checkMondayRecap(island), 15 * 60_000);

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
