// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { PlanUsage } from "./plan";

export type AgentSource = "claudeCode" | "n8n" | "agent";
/** Whose brain answers the chat: Codex's Mochi uses OpenAI, the others Anthropic. */
export type ChatProvider = "anthropic" | "openai";

export function chatProviderFor(focusId: string | null): ChatProvider {
  return focusId === "agent_codex" ? "openai" : "anthropic";
}

/**
 * The pills where you code: Claude Code and Codex. Each shows its session's
 * project in the ticker, its own name on the pill, and an integration card
 * when no session is running.
 */
export function isWorkspace(task: AgentTask | null): boolean {
  return task != null && (task.source === "claudeCode" || task.id === "agent_codex");
}

/** The agent's own name, for pills and card labels (the ticker shows the project). */
export function agentLabel(task: AgentTask | null): string {
  if (!task || task.source === "claudeCode") return "Claude Code";
  if (task.id === "agent_codex") return "Codex";
  return task.name;
}

/**
 * The grey label beside the name in the ticker and on cards. Claude Code's
 * name is its project, so the label names the agent; Codex is always called
 * Codex and reads "Codex · Integration", like its idle card.
 */
export function sessionLabel(task: AgentTask | null): string {
  if (task?.id === "agent_codex") return "Integration";
  return agentLabel(task);
}

export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** The chat the pill shows: for Codex, the thread "Open in Codex" opens. */
  sessionId?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** The pill that asked: Claude Code or Codex. */
  pillId: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "Claude Code", "#D97757", "claudeCode"),
  task("agent_codex", "Codex", "#7DD3FC", "agent"),
  task("integration_vscode", "VS Code", "#A855F7", "n8n"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_vscode", "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** OpenAI model used by Codex's Mochi with an API key. */
  openaiModel: string;
  /** Codex's Mochi signs in through the Codex CLI (ChatGPT plan) or an API key. */
  openaiAuth: "codex" | "apiKey";
  /** Claude's Mochi signs in through Claude Code (Claude plan) or an API key. */
  anthropicAuth: "claudeCode" | "apiKey";
  /** The Claude plan pill in the header (needs the status line relay). */
  showPlanUsage: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  openaiModel: "gpt-6.1-sol",
  openaiAuth: "codex",
  anthropicAuth: "claudeCode",
  showPlanUsage: false,
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  /** One conversation per Mochi, so switching pills never mixes them. */
  chatHistories: Record<ChatProvider, ChatMessage[]> = { anthropic: [], openai: [] };
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** Claude plan usage from Claude Code's status line, and whether its relay is in. */
  planUsage: PlanUsage | null = null;
  planRelayInstalled = false;
  /** Codex's plan usage, from its own session logs. */
  codexUsage: PlanUsage | null = null;
  /** Whose plan card replaces the left card; any navigation closes it. */
  planDetail: "claude" | "codex" | null = null;

  usageFor(kind: "claude" | "codex"): PlanUsage | null {
    return kind === "claude" ? this.planUsage : this.codexUsage;
  }

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  /** Follows the Mochi on screen, which takes the focused pill's colour. */
  get chatProvider(): ChatProvider {
    return chatProviderFor(this.focusTask?.id ?? null);
  }

  /** The conversation of the Mochi on screen. */
  get chatHistory(): ChatMessage[] {
    return this.chatHistories[this.chatProvider];
  }

  /** A dropped file starts a new conversation with both Mochis. */
  resetChats() {
    this.chatHistories = { anthropic: [], openai: [] };
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.planDetail = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — Claude Code and Codex always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
  proto.id === "integration_claude" ||
  proto.id === "agent_codex" ||
  this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) {
  this.focusId = this.tasks.some((t) => t.id === "agent_codex")
    ? "agent_codex"
    : "integration_claude";
}
    this.notify();
  }

  removeTask(id: string) {
  const idx = this.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return;

  const persistent =
    id === "integration_claude" ||
    id === "agent_codex" ||
    this.settings.activeIntegrations.includes(id);

  if (persistent) {
    const t = this.tasks[idx];
    t.state = "idle";
    t.steps = [];
    t.stepIndex = 0;
    t.pillBadge = null;
    this.notify();
    return;
  }

  this.tasks.splice(idx, 1);

  if (this.focusId === id) {
    this.focusId = this.tasks.some((t) => t.id === "agent_codex")
      ? "agent_codex"
      : this.tasks[0]?.id ?? "integration_claude";
  }

  this.notify();
}

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
