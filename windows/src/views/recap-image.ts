// The weekly recap's share image (RecapShareImageView): 1080×1920, drawn on a
// canvas and saved as a PNG that opens in Windows' image viewer, where it can
// be copied or shared.

import { Bridge } from "../core/bridge";
import { formatDuration, weekRangeLabel, type WeeklySummary } from "../core/recap";
import { BotEngine } from "../mochi/engine";

export const IMAGE_W = 1080;
export const IMAGE_H = 1920;

const SANS = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const MONO = '"Cascadia Mono", Consolas, monospace';
const INK = "#F1F2F4";
const DIM = "#8E939C";

type Ctx = CanvasRenderingContext2D;

function font(x: Ctx, weight: number, size: number, family = SANS, tracking = 0) {
  x.font = `${weight} ${size}px ${family}`;
  // Tracking where the canvas supports it (Chromium does).
  if ("letterSpacing" in x) (x as Ctx & { letterSpacing: string }).letterSpacing = `${tracking}px`;
}

/** One line of text at `y` (its top), shrunk to fit `maxW` down to `minScale`. */
function text(x: Ctx, s: string, cx: number, y: number, size: number, opts: {
  weight?: number; color?: string; family?: string; tracking?: number; maxW?: number; minScale?: number;
  align?: CanvasTextAlign;
} = {}) {
  const { weight = 400, color = INK, family = SANS, tracking = 0, maxW = Infinity, minScale = 1, align = "center" } = opts;
  font(x, weight, size, family, tracking);
  const w = x.measureText(s).width;
  if (w > maxW) font(x, weight, Math.max(size * minScale, (size * maxW) / w), family, tracking);
  x.fillStyle = color;
  x.textAlign = align;
  x.textBaseline = "top";
  x.fillText(s, cx, y, maxW === Infinity ? undefined : maxW);
}

/** The space a line of `size` takes in a stack, as SwiftUI lays it out. */
const lineH = (size: number) => Math.round(size * 1.2);

function roundRect(x: Ctx, left: number, top: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(left + r, top);
  x.arcTo(left + w, top, left + w, top + h, r);
  x.arcTo(left + w, top + h, left, top + h, r);
  x.arcTo(left, top + h, left, top, r);
  x.arcTo(left, top, left + w, top, r);
  x.closePath();
}

const BADGE_H = 18 * 2 + lineH(24);

function badge(x: Ctx, label: string, value: string, left: number, top: number, w: number) {
  roundRect(x, left, top, w, BADGE_H, 18);
  x.fillStyle = "rgba(255,255,255,0.05)";
  x.fill();
  const y = top + 18;
  text(x, label, left + 32, y, 24, { color: DIM, align: "left" });
  font(x, 400, 24);
  const labelW = x.measureText(label).width;
  text(x, value, left + w - 32, y, 24, { weight: 600, align: "right", maxW: Math.max(40, w - 64 - labelW - 16) });
}

/** Rows of badges, as the image lists them: label, then value. */
export function badgesOf(s: WeeklySummary, hideProjects: boolean): [string, string][][] {
  const rows: [string, string][][] = [];
  if (s.topAgent) rows.push([["Top agent", s.topAgent]]);
  if (!hideProjects && s.topProject) rows.push([["Top project", s.topProject]]);
  if (s.busiestDay) rows.push([["Busiest day", s.busiestDay]]);
  if (s.longestSessionMinutes > 1) rows.push([["Longest session", formatDuration(s.longestSessionMinutes)]]);
  if (s.permissionsAllowed + s.permissionsDenied > 0) {
    rows.push([["Approved", String(s.permissionsAllowed)], ["Denied", String(s.permissionsDenied)]]);
  }
  return rows;
}

/** The stat blocks under the time: sessions, files, and commands when any ran. */
export function statsOf(s: WeeklySummary): [string, string][] {
  const stats: [string, string][] = [[String(s.sessionCount), "SESSIONS"], [String(s.filesChanged), "FILES"]];
  if (s.commandsRun > 0) stats.push([String(s.commandsRun), "COMMANDS"]);
  return stats;
}

export function drawRecapImage(x: Ctx, s: WeeklySummary, hideProjects: boolean, drawMochi: (x: Ctx, size: number) => void) {
  const W = IMAGE_W;
  const H = IMAGE_H;
  x.fillStyle = "#0B0C0E";
  x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W * 0.5, H * 0.75, 0, W * 0.5, H * 0.75, 900);
  glow.addColorStop(0, "rgba(99,102,241,0.30)");
  glow.addColorStop(0.65, "rgba(99,102,241,0)");
  x.fillStyle = glow;
  x.fillRect(0, 0, W, H);

  const lines = s.linesAdded + s.linesRemoved > 0;
  const rows = badgesOf(s, hideProjects);
  const statH = lineH(64) + 8 + lineH(18);
  const content = 200 + 20 + lineH(52) + 6 + lineH(30) + 14 + lineH(24) + 80
    + lineH(100) + 6 + lineH(22)
    + 56 + statH
    + (lines ? 24 + lineH(28) : 0)
    + (rows.length ? 56 + rows.length * BADGE_H + (rows.length - 1) * 16 : 0);
  const footer = lineH(20) + 60;
  // The two spacers share what is left; the footer sits under the lower one.
  let y = Math.max(40, (H - footer - content) / 2);

  x.save();
  x.translate(W / 2 - 100, y);
  drawMochi(x, 200);
  x.restore();
  y += 220;
  text(x, "Coucou", W / 2, y, 52, { weight: 900 });
  y += lineH(52) + 6;
  text(x, "Weekly recap", W / 2, y, 30, { weight: 500, color: DIM });
  y += lineH(30) + 14;
  text(x, weekRangeLabel(s), W / 2, y, 24, { color: "#818CF8" });
  y += lineH(24) + 80;

  text(x, formatDuration(s.totalMinutes), W / 2, y, 100, { weight: 900, maxW: W - 80, minScale: 0.4 });
  y += lineH(100) + 6;
  text(x, "TIME CODING", W / 2, y, 22, { weight: 600, color: DIM, tracking: 3 });
  y += lineH(22) + 56;

  const stats = statsOf(s);
  const rowW = W - 80;
  const cell = rowW / stats.length;
  stats.forEach(([value, label], i) => {
    const cx = 40 + cell * (i + 0.5);
    text(x, value, cx, y, 64, { weight: 900, maxW: cell - 20, minScale: 0.5 });
    text(x, label, cx, y + lineH(64) + 8, 18, { weight: 600, color: DIM, tracking: 2 });
    if (i > 0) {
      x.fillStyle = "rgba(255,255,255,0.08)";
      x.fillRect(40 + cell * i, y + (statH - 80) / 2, 1, 80);
    }
  });
  y += statH;

  if (lines) {
    y += 24;
    font(x, 600, 28, MONO);
    const plus = `+${s.linesAdded}`;
    const minus = `−${s.linesRemoved}`;
    const pw = x.measureText(plus).width;
    const mw = x.measureText(minus).width;
    const left = W / 2 - (pw + 24 + mw) / 2;
    text(x, plus, left, y, 28, { weight: 600, family: MONO, color: "#4ADE80", align: "left" });
    text(x, minus, left + pw + 24, y, 28, { weight: 600, family: MONO, color: "#F87171", align: "left" });
    y += lineH(28);
  }

  if (rows.length) {
    y += 56;
    const left = 60;
    const width = W - 120;
    for (const row of rows) {
      const w = (width - (row.length - 1) * 16) / row.length;
      row.forEach(([label, value], i) => badge(x, label, value, left + i * (w + 16), y, w));
      y += BADGE_H + 16;
    }
  }

  font(x, 500, 20, MONO);
  x.globalAlpha = 0.6;
  text(x, "Coucou · github.com/Louis-CFM/coucou", W / 2, H - footer, 20, { weight: 500, family: MONO, color: DIM });
  x.globalAlpha = 1;
}

/** Draws the image, saves it under Pictures\Coucou and opens it. Returns the path. */
export async function shareRecapImage(s: WeeklySummary, hideProjects: boolean): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_W;
  canvas.height = IMAGE_H;
  const x = canvas.getContext("2d");
  if (!x) throw new Error("No canvas to draw the image on.");
  drawRecapImage(x, s, hideProjects, (ctx, size) => {
    // Mochi as he is at rest, as the macOS image draws him.
    const mochi = new BotEngine();
    mochi.update(0);
    mochi.draw(ctx, size, size);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not draw the image.");
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const d = s.weekStart;
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return Bridge.recapSaveImage(bytes, `coucou-weekly-recap-${day}`);
}
