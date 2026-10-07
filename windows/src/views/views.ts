// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { MUSIC_ID, State, agentLabel, isWorkspace, sessionLabel, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { renderPlanCard } from "./plan";
import { nowSeconds } from "../core/plan";
import { formatSpeed } from "../core/net";
import { Bridge } from "../core/bridge";
import { OUTFITS, drawOutfitIcon, outfitName, parseOutfit, seasonalOutfit, type Outfit } from "../mochi/outfits";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  openVSCode(): void;
  /** The Claude desktop app, from the Claude Code pill. */
  openClaudeApp(): void;
  /** The Codex app, at the chat the Codex pill shows. */
  openCodexChat(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  /** The wardrobe: keep this outfit, or wear it while the pointer is over it. */
  pickOutfit(outfit: Outfit): void;
  previewOutfit(outfit: Outfit | null): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while the view still has motion to finish; keeps the frame loop running. */
  animating?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  // Internet speed right now, from the network adapters' counters (sampled by
  // Rust once a second while the island is on screen).
  const down = h("span", { class: "v" });
  const up = h("span", { class: "v" });
  const speed = h("div", {
    class: "net-speed",
    title: "Internet speed right now: download ↓ and upload ↑",
  }, h("span", { class: "arrow", text: "↓" }), down, h("span", { class: "arrow", text: "↑" }), up);

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, speed, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      const net = State.netSpeed;
      speed.hidden = net == null;
      if (net) {
        down.textContent = formatSpeed(net.down);
        up.textContent = formatSpeed(net.up);
      }
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | null = null;
  let cardKey = "";

  // The plan card redraws when its numbers change, and every 30 s for the
  // countdowns and "N min ago", as on macOS.
  const planKey = () => {
    const kind = State.planDetail;
    return `plan~${kind}~${JSON.stringify(kind && State.usageFor(kind))}~${Math.floor(nowSeconds() / 30)}`;
  };
  function showPlan() {
    const kind = State.planDetail;
    if (!kind) return;
    cardKey = planKey();
    mode = "plan";
    clear(leftBody);
    leftBody.append(renderPlanCard(kind, State.usageFor(kind), nowSeconds(), () => {
      State.planDetail = null;
      State.notify();
    }));
  }

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
    openVSCode: () => actions.openVSCode(),
    openClaudeApp: () => actions.openClaudeApp(),
    openPlan: (kind) => {
      actions.blip();
      State.planDetail = kind;
      State.notify();
    },
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
      else if (mode === "plan" && planKey() !== cardKey) showPlan();
    },
    animating: () => mode === "ticker" && ticker.animating,
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // Claude Code and Codex with a live session keep the ticker; with none
      // they show their integration card, exactly like IntegrationCardView.
      // Claude Code's turn is over once it is idle: a VS Code chat stays open
      // for hours, and its last output must not hold the card until then.
      // Codex keeps the selected chat's steps. Other agents only have a pill
      // while a session runs.
      const sessionActive =
  task != null &&
  (
    task.source === "claudeCode"
      ? task.state !== "idle"
      : isWorkspace(task)
      ? task.state !== "idle" || task.steps.length > 0
      : task.source === "agent"
  );

      if (State.planDetail) {
        if (mode !== "plan" || planKey() !== cardKey) showPlan();
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
          // Another pill, or a session after the idle card: start from this
          // task's own lines.
          ticker.reset();
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", {
  class: "tool",
  text: task.source === "n8n" ? "n8n" : sessionLabel(task),
}),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        // The Claude Code and Codex cards show plan usage: ask for fresher
        // numbers while one is open on screen (Rust decides whether to).
        if (State.mode === "expanded" && (task.id === "integration_claude" || task.id === "agent_codex")) {
          requestUsage(task.id === "integration_claude" ? "claude" : "codex");
        }
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
          // The usage line on the Claude Code and Codex cards.
          JSON.stringify(State.planUsage), JSON.stringify(State.codexUsage), Math.floor(nowSeconds() / 60),
          task.id === MUSIC_ID ? JSON.stringify(State.music) : "",
          task.id === "integration_github" ? JSON.stringify([State.githubPulse, State.githubActivity]) : "",
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" ? "none" : "";

      const others = State.otherTasks.slice(0, 4);
      // The Music pill is rebuilt when the track or play state changes.
      const music = State.music ? `${State.music.title}:${State.music.playing}` : "";
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}${t.id === MUSIC_ID ? `:${music}` : ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

const usageAsked: Record<string, number> = {};

function requestUsage(kind: "claude" | "codex") {
  const now = Date.now();
  if (now - (usageAsked[kind] ?? 0) < 30_000) return;
  usageAsked[kind] = now;
  void Bridge.usageRefresh(kind);
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  // Claude Code and Codex keep their names while the ticker shows the project;
  // the Music pill is named after the track (MusicController.syncTaskName).
  const music = task.id === MUSIC_ID ? State.music : null;
  const label = isWorkspace(task) ? agentLabel(task) : music?.title || task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: music ? "pill music" : "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  if (music) {
    // MusicPill: play/pause and next appear on hover once a track is loaded.
    const control = (action: "toggle" | "next", icon: string, title: string) => {
      const b = h("button", { class: "pill-music-btn", title, "aria-label": title }, svg(icon, 8));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        void Bridge.musicControl(action).catch(() => {});
      });
      return b;
    };
    pill.append(h("span", { class: "pill-music" },
      control("toggle", music.playing ? ICONS.pause : ICONS.play, music.playing ? "Pause" : "Play"),
      control("next", ICONS.forward, "Next"),
    ));
  }
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const task = State.focusTask;
      const codex = task?.id === "agent_codex";
      who.append(agentWho(task, `${codex ? "Codex" : "Claude Code"} is asking a question`));
      title.textContent = task?.steps.at(-1) ?? (codex ? "Codex needs an answer." : "Claude needs an answer.");
      clear(row);
      row.append(h("div", {
        class: "sub",
        text: `Answer in ${codex ? "Codex" : "your terminal"} — Coucou can't reply for you yet.`,
      }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : sessionLabel(task)));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const terminal = btn("Open terminal", "primary", () => actions.openTerminal());
  // A Codex chat that finished goes back to where it lives: the Codex app.
  const codexChat = btn("Open in Codex", "primary", () => actions.openCodexChat());
  const vscode = btn("Open in VS Code", "secondary", () => actions.openVSCode());
  const ok = btn("OK", "secondary", () => actions.collapse());
  let first = terminal;
  const row = h("div", { class: "actions" }, first, vscode, ok);
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const task = State.focusTask;
      // "Codex · finished": the name already says Codex.
      const label = task?.id === "agent_codex" ? "finished"
        : task?.source === "agent" ? `${agentLabel(task)} finished` : "Claude Code finished";
      who.append(agentWho(task, label));
      title.textContent = task?.steps.at(-1) ?? "Session finished";
      const inCodex = task?.id === "agent_codex" && !!task.sessionId
        && State.integrations.agent_codex?.data?.app === true;
      // Swap only on a change, so a button under the pointer stays put.
      const want = inCodex ? codexChat : terminal;
      if (want !== first) {
        first = want;
        clear(row);
        row.append(first, vscode, ok);
      }
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const codexBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      codexBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(codexBadge);
      codexBadge.append(
        dot(State.integrations.agent_codex?.configured ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Codex" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Wardrobe ──────────────────────────────────────────────────────────────────

const TILE = 30;

/** "Auto · Witch hat": what the header says for the hovered or chosen outfit. */
export function wardrobeLabel(hovered: Outfit | null, selected: Outfit, today: Date): string {
  const season = seasonalOutfit(today);
  const seasonName = season === "none" ? "None" : outfitName(season);
  if (hovered === "auto") return `Auto · follows the seasons (now: ${seasonName})`;
  if (hovered) return outfitName(hovered);
  return selected === "auto" ? `Auto · ${seasonName}` : outfitName(selected);
}

/** WardrobeView: Mochi on the left, a row of outfits; hover to try, click to keep. */
function buildWardrobe(actions: ViewActions): ViewHost {
  const label = h("span", { class: "wardrobe-label" });
  const grid = h("div", { class: "wardrobe-grid" });
  let hovered: Outfit | null = null;
  const tiles = OUTFITS.map((outfit) => {
    const canvas = h("canvas", { class: "outfit-icon" }) as HTMLCanvasElement;
    const tile = h("button", {
      class: "outfit-tile",
      title: outfitName(outfit),
      "aria-label": outfitName(outfit),
      onclick: () => actions.pickOutfit(outfit),
    }, canvas);
    tile.addEventListener("mouseenter", () => {
      hovered = outfit;
      actions.previewOutfit(outfit === "auto" ? seasonalOutfit(new Date()) : outfit);
    });
    tile.addEventListener("mouseleave", () => {
      if (hovered !== outfit) return;
      hovered = null;
      actions.previewOutfit(null);
    });
    grid.append(tile);
    return { outfit, tile, canvas };
  });
  let paintedFor = "";
  const el = h("div", { class: "view wardrobe" },
    h("div", { class: "wardrobe-head" }, h("span", { class: "wardrobe-title", text: "Wardrobe" }), label),
    grid);

  return {
    el,
    sync() {
      const today = new Date();
      const selected = parseOutfit(State.settings.mochiOutfit);
      label.textContent = wardrobeLabel(hovered, selected, today);
      for (const t of tiles) t.tile.classList.toggle("selected", t.outfit === selected);
      // The icons only change with the season (Auto) and the screen's scale.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const season = seasonalOutfit(today);
      if (paintedFor === `${season}@${dpr}`) return;
      paintedFor = `${season}@${dpr}`;
      for (const t of tiles) {
        t.canvas.width = Math.round(TILE * dpr);
        t.canvas.height = Math.round(TILE * dpr);
        const ctx = t.canvas.getContext("2d");
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, TILE, TILE);
        drawOutfitIcon(ctx, TILE, t.outfit, season);
      }
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
