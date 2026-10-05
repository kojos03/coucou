// Plan usage — the gauge maths behind the header pill, the usage line on the
// Claude Code and Codex cards, and the plan card. Port of ClaudePlanGauge.swift
// (upstream #159): the same colours, thresholds and labels. Times are Unix
// seconds, as Claude Code and Codex record them.

export interface PlanWindow {
  /** 0–100. */
  usedPct: number;
  /** Unix seconds. */
  resetsAt: number;
}

export interface PlanUsage {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  /** Unix seconds of the reply (or check) that brought the numbers. */
  updatedAt: number;
  /** The plan is refusing requests until a window resets. */
  limitReached?: boolean;
}

export const nowSeconds = () => Date.now() / 1000;

/** What a window shows: nothing used once its reset time has passed. */
export function effectivePct(w: PlanWindow, now = nowSeconds()): number {
  return w.resetsAt <= now ? 0 : w.usedPct;
}

/** The fuller of the two windows, or null with no numbers at all. */
export function dominantPct(usage: PlanUsage | null, now = nowSeconds()): number | null {
  if (!usage) return null;
  const pcts = [usage.fiveHour, usage.sevenDay]
    .filter((w): w is PlanWindow => w != null)
    .map((w) => effectivePct(w, now));
  return pcts.length ? Math.max(...pcts) : null;
}

/** Green under 50 %, amber to 80 %, red beyond; grey without numbers. */
export function planColor(pct: number | null): string {
  if (pct == null) return "#6B7079";
  if (pct < 50) return "#22C55E";
  if (pct < 80) return "#F59E0B";
  return "#F4505E";
}

/** "Claude 73%" in the header pill, "Claude —" before the first reply. */
export function pillLabel(usage: PlanUsage | null, now = nowSeconds()): string {
  const pct = dominantPct(usage, now);
  return pct == null ? "Claude —" : `Claude ${Math.round(pct)}%`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "in 1 h 20" / "in 12 min" for the 5-hour window, "Mon 9:00" for the week. */
export function resetLabel(w: PlanWindow, weekly: boolean, now = nowSeconds()): string {
  const secs = w.resetsAt - now;
  if (secs <= 0) return "Resetting…";
  if (weekly) {
    const at = new Date(w.resetsAt * 1000);
    return `${DAYS[at.getDay()]} ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `in ${h} h ${m}` : `in ${m} min`;
}

/** The card's subtitle: how fresh the numbers are. */
export function ageLabel(usage: PlanUsage | null, now = nowSeconds(), agent = "Claude Code"): string {
  if (!usage) return `Waiting for a ${agent} reply`;
  const diff = now - usage.updatedAt;
  if (diff < 60) return "just now";
  const mins = Math.floor(diff / 60);
  return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
}
