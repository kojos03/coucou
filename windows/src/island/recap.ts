// When the weekly recap card opens by itself: Monday from 8 am, once a week
// (AppDelegate.checkMondayRecap). Checked at launch, every quarter of an hour
// (which also covers waking from sleep) and when an agent starts or is prompted.

import { mondayRecapDue, Recap } from "../core/recap";
import { State } from "../core/state";
import type { Island } from "./island";

let pending = false;

export function checkMondayRecap(island: Island, now = new Date()) {
  if (pending || State.paused) return;
  const week = mondayRecapDue(now, Recap, State.pendingApproval != null);
  if (week == null) return;
  pending = true;
  // A moment later, as on macOS, so the event that triggered it lands first.
  window.setTimeout(() => {
    pending = false;
    if (State.pendingApproval || State.paused) return;
    island.alert("recap");
    Recap.markShown(week);
  }, 1500);
}
