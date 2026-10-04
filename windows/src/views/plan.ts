// The Claude plan card: what the header pill opens in place of the left card.
// Port of ClaudePlanCardView.swift (upstream #159), in the island's own
// integration-card layout.

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import {
  ageLabel, dominantPct, effectivePct, planColor, resetLabel, type PlanUsage, type PlanWindow,
} from "../core/plan";

function row(label: string, w: PlanWindow | null, weekly: boolean, now: number): HTMLElement {
  const el = h("div", { class: "plan-row" }, h("span", { class: "plan-label", text: label }));
  if (!w) {
    el.append(h("span", { class: "plan-none", text: "—" }));
    return el;
  }
  const pct = effectivePct(w, now);
  const fill = h("i", {});
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  fill.style.background = planColor(pct);
  el.append(
    h("span", { class: "plan-bar" }, fill),
    h("span", { class: "plan-pct", text: `${Math.round(pct)}%` }),
    svg(ICONS.refresh, 9, { stroke: 2.4 }),
    h("span", { class: "plan-reset", text: resetLabel(w, weekly, now) }),
  );
  return el;
}

export function renderPlanCard(usage: PlanUsage | null, now: number): HTMLElement {
  return h(
    "div",
    { class: "int-card plan-card" },
    h("div", { class: "int-head" },
      dot(planColor(dominantPct(usage, now)), 7),
      h("b", { text: "Claude plan" }),
      h("span", { text: ageLabel(usage, now) }),
    ),
    h("div", { class: "plan-rows" },
      row("5 hours", usage?.fiveHour ?? null, false, now),
      row("Week", usage?.sevenDay ?? null, true, now),
    ),
  );
}
