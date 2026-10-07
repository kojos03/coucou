// The weekly recap (RecapStore.swift): a local history of agent turns and of
// the permission decisions made in the island, kept for 12 weeks and summed up
// Monday to Sunday. It lives in %LOCALAPPDATA%\Coucou\recap.json and never
// leaves the computer.

import { Bridge } from "./bridge";
import { State } from "./state";

export interface RecapTurn {
  pillId: string;
  project: string;
  /** Epoch milliseconds. */
  start: number;
  end: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  questions: number;
}

export interface RecapDecision {
  pillId: string;
  date: number;
  /** "allow", "always", "deny" or "ask". */
  decision: string;
}

export interface RecapData {
  turns: RecapTurn[];
  decisions: RecapDecision[];
  schemaVersion: 1;
  /** ISO week (year × 100 + week) whose Monday card was last shown. */
  lastShownWeek?: number;
}

export interface WeeklySummary {
  weekStart: Date;
  /** The last second of the week, Sunday 23:59:59. */
  weekEnd: Date;
  totalMinutes: number;
  sessionCount: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  questionsAnswered: number;
  permissionsAllowed: number;
  permissionsDenied: number;
  topAgent: string | null;
  topProject: string | null;
  busiestDay: string | null;
  longestSessionMinutes: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Tools that run a command: macOS's three, plus the shells Windows agents use. */
const COMMAND_TOOLS = new Set([
  "Bash", "Execute", "mcp__ide__executeCode", "PowerShell", "bash", "powershell", "shell", "exec_command",
]);
const AGENT_NAMES: Record<string, string> = {
  integration_claude: "Claude Code",
  agent_codex: "Codex",
  agent_copilot: "Copilot CLI",
  agent_muse: "Muse Code",
};
const HOUR = 3600_000;
/** A turn with no event for this long is closed as it stands (agent crashed, no Stop). */
const STALE_MS = 2 * HOUR;
const KEEP_WEEKS = 12;

/** Midnight at the start of the Monday of `date`'s week, local time. */
export function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** ISO 8601 week of `date` as year × 100 + week, e.g. 202641. */
export function isoWeekKey(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return d.getUTCFullYear() * 100 + Math.ceil(((d.getTime() - yearStart) / 86400_000 + 1) / 7);
}

/** The pill's name as the recap shows it. */
export function agentName(pillId: string): string {
  if (AGENT_NAMES[pillId]) return AGENT_NAMES[pillId];
  const bare = pillId.replace(/^(agent|integration)_/, "");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** Parallel turns count once: the length of the union of their intervals. */
function mergedTotalMs(turns: RecapTurn[]): number {
  const sorted = turns.filter((t) => t.end > t.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let seg: [number, number] | null = null;
  for (const t of sorted) {
    if (seg && t.start <= seg[1]) seg[1] = Math.max(seg[1], t.end);
    else {
      if (seg) total += seg[1] - seg[0];
      seg = [t.start, t.end];
    }
  }
  return seg ? total + seg[1] - seg[0] : total;
}

/** The key with the highest count; the first one seen wins a tie. */
function topOf(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [key, n] of counts) if (n > most) [best, most] = [key, n];
  return best;
}

function count<T>(items: T[], key: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

const sum = (turns: RecapTurn[], field: keyof RecapTurn) =>
  turns.reduce((n, t) => n + (t[field] as number), 0);

interface Draft {
  pillId: string;
  project: string;
  start: number;
  lastEvent: number;
  paths: Set<string>;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  questions: number;
}

function emptyData(): RecapData {
  return { turns: [], decisions: [], schemaVersion: 1 };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class RecapStore {
  private data: RecapData = emptyData();
  /** Turns in progress, by session, so parallel sessions are kept apart. */
  private drafts = new Map<string, Draft>();

  constructor(
    private readonly opts: {
      enabled: () => boolean;
      persist: (text: string) => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The saved history; anything malformed in it is dropped. */
  load(text: string | null) {
    this.data = emptyData();
    if (!text) return;
    try {
      const raw = JSON.parse(text) as Partial<RecapData>;
      this.data.turns = (Array.isArray(raw.turns) ? raw.turns : []).filter(
        (t) => t && typeof t.pillId === "string" && isNum(t.start) && isNum(t.end),
      );
      this.data.decisions = (Array.isArray(raw.decisions) ? raw.decisions : []).filter(
        (d) => d && typeof d.pillId === "string" && isNum(d.date) && typeof d.decision === "string",
      );
      if (isNum(raw.lastShownWeek)) this.data.lastShownWeek = raw.lastShownWeek;
    } catch {
      /* Rust sets unreadable files aside; nothing to keep here */
    }
    this.prune();
  }

  get lastShownWeek(): number | undefined {
    return this.data.lastShownWeek;
  }

  markShown(weekKey: number) {
    this.data.lastShownWeek = weekKey;
    this.persist();
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  userPromptSubmit(sessionId: string, pillId: string, project: string) {
    if (!this.opts.enabled()) return;
    this.closeStale();
    const now = this.now();
    const draft = this.drafts.get(sessionId);
    if (draft) draft.lastEvent = now;
    else {
      this.drafts.set(sessionId, {
        pillId, project, start: now, lastEvent: now, paths: new Set(),
        linesAdded: 0, linesRemoved: 0, commandsRun: 0, questions: 0,
      });
    }
  }

  preToolUse(sessionId: string, tool: string) {
    const draft = this.live(sessionId);
    if (!draft) return;
    if (COMMAND_TOOLS.has(tool)) draft.commandsRun += 1;
  }

  /** An edit's line counts, from the relay's `coucou_diff`. */
  recordFileDiff(sessionId: string, path: string, added: number, removed: number) {
    const draft = this.live(sessionId);
    if (!draft) return;
    draft.paths.add(path);
    draft.linesAdded += added;
    draft.linesRemoved += removed;
  }

  /** A question answered from the island (not when it is asked). */
  recordQuestionAnswered(sessionId: string) {
    const draft = this.live(sessionId);
    if (draft) draft.questions += 1;
  }

  stop(sessionId: string) {
    if (!this.opts.enabled()) return;
    const draft = this.drafts.get(sessionId);
    if (!draft) return;
    this.drafts.delete(sessionId);
    this.data.turns.push(this.turnOf(draft, this.now()));
    this.prune();
    this.closeStale();
    this.persist();
  }

  sessionEnd(sessionId: string) {
    this.drafts.delete(sessionId);
  }

  recordDecision(pillId: string, decision: string) {
    if (!this.opts.enabled()) return;
    this.data.decisions.push({ pillId, date: this.now(), decision });
    this.prune();
    this.closeStale();
    this.persist();
  }

  clear() {
    this.data = emptyData();
    this.drafts.clear();
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  /** The last full week, Monday to Sunday, or the week starting `weekStart`;
   * null when it has no turns. */
  weeklySummary(weekStart?: Date): WeeklySummary | null {
    const start = weekStart ?? addDays(mondayOf(new Date(this.now())), -7);
    const end = addDays(start, 7);
    const [from, to] = [start.getTime(), end.getTime()];
    const turns = this.data.turns.filter((t) => t.start >= from && t.start < to);
    if (!turns.length) return null;
    const decisions = this.data.decisions.filter((d) => d.date >= from && d.date < to);
    const topAgent = topOf(count(turns, (t) => t.pillId));
    const busiest = topOf(count(turns, (t) => String(new Date(t.start).getDay())));
    return {
      weekStart: start,
      weekEnd: new Date(to - 1000),
      totalMinutes: Math.floor(mergedTotalMs(turns) / 60_000),
      sessionCount: turns.length,
      filesChanged: sum(turns, "filesChanged"),
      linesAdded: sum(turns, "linesAdded"),
      linesRemoved: sum(turns, "linesRemoved"),
      commandsRun: sum(turns, "commandsRun"),
      questionsAnswered: sum(turns, "questions"),
      permissionsAllowed: decisions.filter((d) => d.decision === "allow" || d.decision === "always").length,
      permissionsDenied: decisions.filter((d) => d.decision === "deny").length,
      topAgent: topAgent ? agentName(topAgent) : null,
      topProject: topOf(count(turns, (t) => t.project || null)),
      busiestDay: busiest ? DAY_NAMES[Number(busiest)] : null,
      longestSessionMinutes: Math.floor(Math.max(...turns.map((t) => t.end - t.start)) / 60_000),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private live(sessionId: string): Draft | undefined {
    if (!this.opts.enabled()) return undefined;
    const draft = this.drafts.get(sessionId);
    if (draft) draft.lastEvent = this.now();
    return draft;
  }

  private turnOf(draft: Draft, end: number): RecapTurn {
    return {
      pillId: draft.pillId, project: draft.project, start: draft.start, end,
      filesChanged: draft.paths.size, linesAdded: draft.linesAdded, linesRemoved: draft.linesRemoved,
      commandsRun: draft.commandsRun, questions: draft.questions,
    };
  }

  /** Turns silent for two hours are kept as they stand, ending at their last event. */
  private closeStale() {
    const cutoff = this.now() - STALE_MS;
    let closed = false;
    for (const [key, draft] of this.drafts) {
      if (draft.lastEvent >= cutoff) continue;
      this.data.turns.push(this.turnOf(draft, draft.lastEvent));
      this.drafts.delete(key);
      closed = true;
    }
    if (closed) {
      this.prune();
      this.persist();
    }
  }

  private prune() {
    const cutoff = addDays(new Date(this.now()), -7 * KEEP_WEEKS).getTime();
    this.data.turns = this.data.turns.filter((t) => t.start >= cutoff);
    this.data.decisions = this.data.decisions.filter((d) => d.date >= cutoff);
  }

  private persist() {
    this.opts.persist(JSON.stringify(this.data));
  }
}

/**
 * The Monday card (AppDelegate.checkMondayRecap): from 8 am on Monday, once a
 * week, when last week has something to show and no approval is waiting.
 * Returns the week to mark as shown, or null.
 */
export function mondayRecapDue(now: Date, store: RecapStore, approvalPending: boolean): number | null {
  if (now.getDay() !== 1 || now.getHours() < 8 || approvalPending) return null;
  const week = isoWeekKey(now);
  if (store.lastShownWeek === week || !store.weeklySummary()) return null;
  return week;
}

/** "5m", "2h", "2h 5m". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 28 – Oct 4". */
export function weekRangeLabel(s: WeeklySummary): string {
  const day = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${day(s.weekStart)} – ${day(s.weekEnd)}`;
}

/** The island's history, saved after every finished turn and decision. */
export const Recap = new RecapStore({
  enabled: () => State.settings.recapEnabled !== false,
  persist: (text) => void Bridge.recapSave(text),
});
