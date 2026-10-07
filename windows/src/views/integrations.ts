// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import {
  State, type AgentTask, type CiState, type GitHubActivity, type GitHubDay, type GitHubPR,
  type GitHubPulse, type GitHubRepoCI,
} from "../core/state";
import { Bridge } from "../core/bridge";
import { refreshCodexHooks } from "../island/integrations";
import { effectivePct, nowSeconds, planColor, resetLabel, type PlanUsage, type PlanWindow } from "../core/plan";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), kind ? h("span", { text: kind }) : null);
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

/** The Codex card's status, from ~/.codex/hooks.json: worded like Claude Code's. */
function codexStatus(configured: boolean, data: Record<string, unknown>): [string, string] {
  if (configured) return ["Connected", "#22C55E"];
  // Sessions still show up, but approvals need the entries that are missing.
  if (data.anyInstalled === true) return ["Connected · repair hooks", "#F5A524"];
  return ["Hooks not installed", "#F4505E"];
}

/** One window on the usage line: `5h ▬▬ 62%`. */
function miniGauge(label: string, w: PlanWindow | null, now: number): HTMLElement {
  const el = h("span", { class: "g" }, h("span", { text: label }));
  if (!w) {
    el.append(h("b", { text: "—" }));
    return el;
  }
  const pct = effectivePct(w, now);
  const fill = h("i", {});
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  fill.style.background = planColor(pct);
  el.append(h("span", { class: "bar" }, fill), h("b", { text: `${Math.round(pct)}%` }));
  return el;
}

function usageTitle(usage: PlanUsage, now: number): string {
  const part = (name: string, w: PlanWindow | null, weekly: boolean) =>
    w ? `${name}: ${Math.round(effectivePct(w, now))}%, resets ${resetLabel(w, weekly, now)}` : null;
  return [part("5 hours", usage.fiveHour, false), part("Week", usage.sevenDay, true)]
    .filter(Boolean)
    .join(" · ") + " — click for details";
}

/** The window that is full, when the plan has stopped answering. */
function fullWindow(usage: PlanUsage, now: number): ["5-hour" | "Weekly", PlanWindow, boolean] | null {
  const full = (w: PlanWindow | null) => w != null && effectivePct(w, now) >= 100;
  if (full(usage.sevenDay)) return ["Weekly", usage.sevenDay!, true];
  if (full(usage.fiveHour)) return ["5-hour", usage.fiveHour!, false];
  if (!usage.limitReached) return null;
  // Refused, but no window reads 100 %: name the fuller one.
  const week = usage.sevenDay ? effectivePct(usage.sevenDay, now) : -1;
  const five = usage.fiveHour ? effectivePct(usage.fiveHour, now) : -1;
  if (week < 0 && five < 0) return null;
  return week >= five ? ["Weekly", usage.sevenDay!, true] : ["5-hour", usage.fiveHour!, false];
}

/**
 * The plan line under the status on the Claude Code and Codex cards:
 * `5h ▬ 62%  week ▬ 35%`, or, at the limit, which one and when it resets.
 * Claude's numbers are one pool for Claude Code, Cowork and the Claude apps.
 */
function usageRow(kind: "claude" | "codex", openPlan?: (kind: "claude" | "codex") => void): HTMLElement {
  const usage = State.usageFor(kind);
  if (!usage) return h("div", { class: "int-usage", text: "Checking plan usage…" });
  const now = nowSeconds();
  const full = fullWindow(usage, now);
  const content = full
    ? [h("span", { class: "full", text: `${full[0]} limit reached · resets ${resetLabel(full[1], full[2], now)}` })]
    : [miniGauge("5h", usage.fiveHour, now), miniGauge("week", usage.sevenDay, now)];
  return h("button", {
    class: "int-usage",
    title: usageTitle(usage, now),
    onclick: () => openPlan?.(kind),
  }, ...content);
}

function idleCard(
  task: AgentTask, openSettings: () => void, openVSCode: () => void, openClaudeApp?: () => void,
  openPlan?: (kind: "claude" | "codex") => void,
): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const error = info?.error ?? null;
  const codex = task.id === "agent_codex";
  const vscode = task.id === "integration_vscode";
  const music = task.id === "integration_music";
  // The Claude Code and Codex pills are about hooks, not a key — the macOS
  // wording would be misleading here. VS Code and Music need neither.
  const missing = task.id === "integration_claude" ? "Hooks not installed"
    : vscode ? "Not installed" : music ? "Not available on this system yet" : "Key not configured";
  const [codexLabel, codexColor] = codexStatus(configured, (info?.data ?? {}) as Record<string, unknown>);
  const label = error ?? (codex ? codexLabel
    : !configured ? missing
    : vscode ? "Installed"
    : music ? "Not playing"
    // Claude Code's card has nothing to load: the hooks are either in or not.
    : task.id === "integration_claude" ? "Connected" : "Connected · loading…");
  const statusColor = error ? "#F4505E" : codex ? codexColor : configured ? "#22C55E" : "#F4505E";

  const actions = h("div", { class: "int-actions" });
  if (codex) {
    // Like "Open Codex" on macOS: shown when the Codex app is installed.
    if (info?.data?.app === true) {
      actions.append(
        h("button", {
          class: "link-btn",
          style: `color:${task.color}d9`,
          text: "Open Codex",
          onclick: () => void Bridge.openCodex().catch(() => {}),
        }),
      );
    }
  } else if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open Claude app",
        onclick: () => openClaudeApp?.(),
      }),
    );
  } else if (vscode) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open Visual Studio Code",
        onclick: openVSCode,
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open n8n",
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: `Open ${task.name}`,
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  if (vscode || music) {
    // Nothing to configure or refresh: VS Code only has to be installed, and
    // Music reads whatever player Windows shows.
  } else if (configured) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Refresh",
        onclick: () => {
          if (codex) void refreshCodexHooks();
          else void Bridge.refreshIntegration(task.id);
          // The plan line too, right away.
          if (codex || task.id === "integration_claude") void Bridge.usageRefresh(codex ? "codex" : "claude", true);
        },
      }),
    );
  } else {
    actions.append(
      h("button", {
        class: "link-btn",
        style: "color:#8e939c",
        text: "Settings…",
        onclick: codex ? () => void Bridge.openSettingsWindow("codex") : openSettings,
      }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(task.color, task.id === "integration_claude" ? "Claude Code" : codex ? "Codex" : task.name, "Integration"),
    h("div", { class: "int-status" }, dot(statusColor, 5), h("span", { text: label })),
    task.id === "integration_claude" ? usageRow("claude", openPlan) : codex ? usageRow("codex", openPlan) : null,
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: "Details", onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", "Deployments"), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? "Ready" : d.state === "CANCELED" ? "Canceled" : "Error";
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: `${timeAgo(d.createdAt)} ago` }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? "Deployment") }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", "Emails", extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

function githubCard(): HTMLElement {
  const d = get("integration_github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", "Overview"),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#F5A524", "Total stars", fmt(stars)),
      statRow(ICONS.stack, "#6B7079", "Repositories", String(repos)),
    ),
  );
}

// ── GitHub pulse (GitHubPulseCardView, GitHubDetailView) ───────────────────────

export type GitHubSection = "myPRs" | "toReview" | "mainCI" | "activity";
/** Which list the card's detail shows; the overview owns whether it is open. */
let githubSection: GitHubSection = "myPRs";

const CI_COLOR: Record<CiState, string> = {
  failure: "#F4505E", pending: "#F5A524", success: "#22C55E", unknown: "#6B7079",
};
/** Contribution levels 0–4, GitHub's dark palette. */
const CONTRIB = ["rgba(255,255,255,0.06)", "#0E4429", "#006D32", "#26A641", "#39D353"];
const ACTIVITY_WEEKS = 23; // floor((202 + 1.5) / (7 + 1.5)), as on macOS

export function worstCi(states: CiState[]): CiState {
  for (const s of ["failure", "pending", "success"] as const) if (states.includes(s)) return s;
  return "unknown";
}

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function lastDays(a: GitHubActivity, n: number): GitHubDay[] {
  return a.weeks.flat().slice(-n);
}

/** "Oct 7 · 3 contributions" */
export function dayLabel(day: GitHubDay): string {
  const [, m, d] = day.date.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const when = m >= 1 && m <= 12 && d ? `${months[m - 1]} ${d}` : day.date;
  const what = day.count === 0 ? "No contributions" : day.count === 1 ? "1 contribution" : `${day.count} contributions`;
  return `${when} · ${what}`;
}

/** Only github.com links leave the island. */
function openGitHub(url: string) {
  try {
    if (new URL(url).host === "github.com") void Bridge.openUrl(url);
  } catch {
    /* not a URL */
  }
}

function statButton(icon: HTMLElement | SVGElement, color: string, label: string, value: string, onClick: () => void) {
  return h(
    "button",
    { class: "int-stat gh-stat", onclick: onClick },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, icon),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

/** My PRs, To review, Default branch CI; stars and the last week up top. */
function githubPulseCard(pulse: GitHubPulse, open: (section: GitHubSection) => void): HTMLElement {
  const d = get("integration_github");
  const activity = State.githubActivity;
  let extra: HTMLElement | undefined;
  if (d.totalStars != null || activity) {
    extra = h("button", { class: "gh-week-btn", title: "Activity", onclick: () => open("activity") });
    if (d.totalStars != null) extra.append(h("span", { text: `★ ${fmtCount(Number(d.totalStars))}` }));
    if (activity) {
      extra.append(h("span", { class: "gh-week" },
        ...lastDays(activity, 7).map((day) => h("i", { style: `background:${CONTRIB[day.level] ?? CONTRIB[0]}` }))));
    }
  }

  const prs = pulse.myPrs;
  const failing = prs.filter((p) => p.ci === "failure").length;
  const pending = prs.filter((p) => p.ci === "pending").length;
  const prValue = prs.length === 0 ? "0"
    : failing > 0 ? `${prs.length} · ${failing} failing`
    : pending > 0 ? `${prs.length} · running` : String(prs.length);

  const main = worstCi(pulse.mainCi.map((r) => r.ci));
  const [mainIcon, mainColor, mainValue] =
    main === "failure" ? [ICONS.octagonX, CI_COLOR.failure, `${pulse.mainCi.filter((r) => r.ci === "failure").length} failing`]
    : main === "pending" ? [ICONS.sealCheck, CI_COLOR.pending, "running"]
    : main === "success" ? [ICONS.sealCheck, CI_COLOR.success, "all green"]
    : [ICONS.sealCheck, CI_COLOR.unknown, pulse.mainCi.length ? "unknown" : "no repos"];

  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", extra ? "" : "Overview", extra),
    h(
      "div",
      { class: "int-stats gh-stats" },
      statButton(svg(ICONS.pullRequest, 10, { stroke: 2 }), CI_COLOR[worstCi(prs.map((p) => p.ci))], "My PRs", prValue,
        () => open("myPRs")),
      statButton(svg(ICONS.eye, 10, { evenOdd: true }), pulse.toReview.length ? "#8AB4F8" : "#6B7079", "To review",
        String(pulse.toReview.length), () => open("toReview")),
      statButton(svg(mainIcon, 10, { evenOdd: true }), mainColor, "Default branch CI", mainValue, () => open("mainCI")),
    ),
  );
}

function prRow(pr: GitHubPR, showCi: boolean): HTMLElement {
  const dotEl = dot(CI_COLOR[pr.ci], 5);
  if (!showCi || pr.ci === "unknown") dotEl.style.opacity = "0";
  return h(
    "button",
    { class: "gh-row", title: pr.title, onclick: () => openGitHub(pr.url) },
    dotEl,
    h("span", { class: "gh-ref", text: `${pr.repo.split("/").pop()}#${pr.number}` }),
    h("span", { class: "gh-title", text: pr.title }),
    pr.isDraft ? h("span", { class: "gh-draft", text: "Draft" }) : null,
  );
}

function repoRow(repo: GitHubRepoCI): HTMLElement {
  const word = { failure: "failing", pending: "running", success: "passing", unknown: "" }[repo.ci];
  const dotEl = dot(CI_COLOR[repo.ci], 5);
  if (repo.ci === "unknown") dotEl.style.opacity = "0";
  return h(
    "button",
    { class: "gh-row", onclick: () => openGitHub(`${repo.url.replace(/\/$/, "")}/actions`) },
    dotEl,
    h("span", { class: "gh-ref", text: repo.repo.split("/").pop() ?? repo.repo }),
    h("span", { class: "gh-title", text: repo.branch }),
    word ? h("span", { class: "gh-word", style: `color:${CI_COLOR[repo.ci]}`, text: word }) : null,
  );
}

function backHead(title: string, onBack: () => void, ...extra: Node[]): HTMLElement {
  return h(
    "div",
    { class: "int-detail-head" },
    h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
    h("b", { text: title }),
    ...extra,
  );
}

function githubDetail(section: GitHubSection, pulse: GitHubPulse, onBack: () => void): HTMLElement {
  if (section === "activity") return githubActivityDetail(pulse, onBack);
  const title = { myPRs: "My PRs", toReview: "To review", mainCI: "Default branch CI" }[section];
  const rows = section === "mainCI"
    ? pulse.mainCi.map(repoRow)
    : (section === "myPRs" ? pulse.myPrs : pulse.toReview).map((pr) => prRow(pr, section === "myPRs"));
  const list = rows.length
    ? h("div", { class: rows.length > 3 ? "gh-list fade" : "gh-list" }, ...rows)
    : h("div", { class: "gh-empty", text: "Nothing here" });
  return h("div", { class: "int-card detail" }, backHead(title, onBack), list);
}

/** The contribution grid: 23 weeks; hover (or click) a day for its count. */
function githubActivityDetail(pulse: GitHubPulse, onBack: () => void): HTMLElement {
  const a = State.githubActivity;
  const repos = get("integration_github").totalRepos;
  const base = a ? `${a.total.toLocaleString("en-US")} past year${repos != null ? ` · ${repos} repos` : ""}` : "";
  const label = h("button", {
    class: "gh-activity-label",
    text: base,
    onclick: () => openGitHub(`https://github.com/${pulse.login}`),
  });
  const card = h("div", { class: "int-card detail" }, backHead("Activity", onBack, ...(a ? [label] : [])));
  if (!a) {
    card.append(h("div", { class: "gh-empty", text: "Loading…" }));
    return card;
  }
  let pinned: string | null = null;
  const grid = h("div", { class: "gh-grid" });
  for (const week of a.weeks.slice(-ACTIVITY_WEEKS)) {
    const col = h("div", { class: "gh-col" });
    for (let dow = 0; dow < 7; dow++) {
      const day = week.find((d) => d.weekday === dow);
      const cell = h("i", { class: day ? "gh-day" : "gh-day empty" });
      if (day) {
        cell.style.background = CONTRIB[day.level] ?? CONTRIB[0];
        cell.addEventListener("mouseenter", () => { label.textContent = dayLabel(day); });
        cell.addEventListener("mouseleave", () => {
          label.textContent = pinned ?? base;
        });
        cell.addEventListener("click", () => {
          pinned = pinned === dayLabel(day) ? null : dayLabel(day);
          label.textContent = pinned ?? base;
        });
      }
      col.append(cell);
    }
    grid.append(col);
  }
  card.append(grid);
  return card;
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? "Payment") }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", "Payments"),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? "Untitled") }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", "Recent"), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: "No calls scheduled" }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? "Meeting") }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", "Schedule"), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void, openVSCode: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings, openVSCode);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", "Workflow"),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? "Workflow" }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? "Workflow" }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? "Success" : "Failed",
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? "Completed successfully." : "No error details available.",
        }),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
  openVSCode(): void;
  openClaudeApp(): void;
  /** The plan card for the usage line on the Claude Code or Codex card. */
  openPlan?(kind: "claude" | "codex"): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return get(id).totalRepos != null;
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    default:
      return false;
  }
}

// ── Music ───────────────────────────────────────────────────────────────────

/** MusicCardView: the track, its artist, and back / play-pause / next. */
function musicCard(): HTMLElement {
  const now = State.music!;
  const control = (action: "toggle" | "next" | "previous", icon: string, label: string, accent: boolean) =>
    h("button", {
      class: accent ? "music-btn accent" : "music-btn",
      title: label,
      "aria-label": label,
      onclick: () => void Bridge.musicControl(action).catch(() => {}),
    }, svg(icon, 11));
  return h(
    "div",
    { class: "int-card music-card" },
    h("div", { class: "music-title" }, dot("#FA2D48", 7), h("b", { text: now.title })),
    now.artist ? h("div", { class: "music-artist", text: now.artist }) : null,
    h("div", { class: "music-controls" },
      control("previous", ICONS.backward, "Previous", false),
      control("toggle", now.playing ? ICONS.pause : ICONS.play, now.playing ? "Pause" : "Play", true),
      control("next", ICONS.forward, "Next", false),
    ),
  );
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_music" && State.music) return musicCard();
  if (task.id === "integration_github" && State.githubPulse) {
    // Opening the card (or a list) refreshes stale data; Rust decides what is stale.
    const activity = hooks.detailOpen && githubSection === "activity";
    void Bridge.githubRefresh(activity ? "activity" : "pulse");
    return hooks.detailOpen
      ? githubDetail(githubSection, State.githubPulse, hooks.closeDetail)
      : githubPulseCard(State.githubPulse, (section) => {
        githubSection = section;
        hooks.openDetail();
      });
  }
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings, hooks.openVSCode);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) {
    return idleCard(task, hooks.openSettings, hooks.openVSCode, hooks.openClaudeApp, hooks.openPlan);
  }

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    default:
      return idleCard(task, hooks.openSettings, hooks.openVSCode, hooks.openClaudeApp);
  }
}

export { clear };
