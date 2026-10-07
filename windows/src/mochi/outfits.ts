// Mochi's wardrobe: port of MochiWardrobe.swift and MochiOutfitDrawing.swift
// (upstream #195) to Canvas 2D. Same outfits, shapes, colours and transitions;
// the Swift is itself a port of design/outfits/mochi-outfits.js.
//
// SwiftUI's GraphicsContext is a value, so `var g = ctx; g.clip(…)` changes only
// the copy: here every copy is a save()/restore() pair. Its drawLayer (one
// composited layer, so overlapping parts never show through each other while an
// outfit fades) is withLayer().

import { Ease } from "../core/anim";

export type Outfit =
  | "auto" | "none" | "partyHat" | "beanie" | "crown" | "sunglasses" | "roundGlasses"
  | "bow" | "scarf" | "witchHat" | "pumpkin" | "santaHat" | "bunnyEars";

/** Wardrobe order, as on macOS (Outfit.allCases with Auto first). */
export const OUTFITS: readonly Outfit[] = [
  "auto", "none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses",
  "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars",
];

const NAMES: Record<Outfit, string> = {
  auto: "Auto (seasons)", none: "None", partyHat: "Party hat", beanie: "Beanie",
  crown: "Crown", sunglasses: "Sunglasses", roundGlasses: "Round glasses", bow: "Bow",
  scarf: "Scarf", witchHat: "Witch hat", pumpkin: "Pumpkin", santaHat: "Santa hat",
  bunnyEars: "Bunny ears",
};

export const outfitName = (outfit: Outfit) => NAMES[outfit];

/** A stored value; anything unknown is Auto, like Outfit.stored. */
export function parseOutfit(raw: unknown): Outfit {
  return typeof raw === "string" && (OUTFITS as readonly string[]).includes(raw) ? (raw as Outfit) : "auto";
}

/** Easter Sunday (Meeus/Jones/Butcher): [month 1–12, day]. */
export function easterDate(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

/**
 * The outfit Auto wears on a day (local calendar). Priority: party hat > Santa
 * hat > witch hat > bunny ears > sunglasses > none. Easter counts calendar days,
 * Good Friday to Easter Monday, as upstream's tests expect.
 */
export function seasonalOutfit(date: Date): Outfit {
  const day = date.getDate(), month = date.getMonth() + 1, year = date.getFullYear();
  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return "partyHat";
  if (month === 12 && day <= 26) return "santaHat";
  if (month === 10 || (month === 11 && day === 1)) return "witchHat";
  const [em, ed] = easterDate(year);
  const delta = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, em - 1, ed)) / 86_400_000);
  if (delta >= -2 && delta <= 1) return "bunnyEars";
  if ((month === 6 && day >= 21) || month === 7 || month === 8) return "sunglasses";
  return "none";
}

export function resolveOutfit(selection: Outfit, date: Date): Outfit {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

/** Glasses, bow, scarf and pumpkin turn with Mochi; hats and ears stay upright. */
export function outfitFollowsRoll(outfit: Outfit): boolean {
  return outfit === "sunglasses" || outfit === "roundGlasses" || outfit === "bow" ||
    outfit === "scarf" || outfit === "pumpkin";
}

// ── Head geometry ─────────────────────────────────────────────────────────────

const EXP = 2.7;
const VIEW_TILT = -0.3;
const ACC_PITCH = 0.4;
const EYE_W = 0.25, EYE_H = 0.27, EYE_SP = 0.37, EYE_P = -0.12;

/** MochiH: head geometry plus the spring lag that makes soft parts trail. */
export interface MochiH {
  R: number; rx: number; ry: number;
  yaw: number; pitch: number; view: number;
  physDx: number; physDy: number; roll: number;
}

export function mochiH(R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0, roll = 0): MochiH {
  return { R, rx: R * 1.14, ry: R * 0.88, yaw, pitch, view: VIEW_TILT, physDx, physDy, roll };
}

export interface EyeFrame {
  sd: number; x: number; y: number; fx: number; fy: number; visible: boolean; w: number; h: number;
}

export function eyeFrames(H: MochiH): EyeFrame[] {
  return [-1, 1].map((sd) => {
    const eyeYaw = sd * EYE_SP + H.yaw;
    const eyePitch = EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    return {
      sd,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(0.18, Math.cos(eyeYaw)),
      fy: Math.max(0.18, cp),
      visible: Math.cos(eyeYaw) * cp > 0.04,
      w: H.R * EYE_W,
      h: H.R * EYE_H,
    };
  });
}

type V3 = [number, number, number];
interface P3 { x: number; y: number; z: number }

function ringR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, EXP), 1 / EXP);
}

function rot3([x, y, z]: V3, yaw: number, pitch: number): V3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, y * cp + z1 * sp, -y * sp + z1 * cp];
}

/** Head-local point (x right, y up, z toward the viewer) to body space. */
function proj(H: MochiH, p: V3): P3 {
  const r = rot3(p, H.yaw, H.view + H.pitch * ACC_PITCH);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** The same, turning with Mochi's roll (glasses, bow, scarf, pumpkin). */
function projRoll(H: MochiH, p: V3): P3 {
  const r = rot3(p, H.yaw, H.view + H.pitch * ACC_PITCH + H.roll);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

function surf(y: number, lon: number, s = 1): V3 {
  const r = ringR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/** Front arc of projected ring points, left to right, between the silhouette tangents. */
function frontSilhouetteArc(pts: P3[]): P3[] {
  const n = pts.length;
  if (n <= 1) return pts;
  let minIdx = 0, maxIdx = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[minIdx].x) minIdx = i;
    if (pts[i].x > pts[maxIdx].x) maxIdx = i;
  }
  if (minIdx === maxIdx) return [pts[minIdx]];
  const walk = (step: number) => {
    const out: P3[] = [];
    let i = minIdx;
    for (;;) {
      out.push(pts[i]);
      if (i === maxIdx || out.length > n) break;
      i = (i + step + n) % n;
    }
    return out;
  };
  const a = walk(1), b = walk(-1);
  const meanZ = (arc: P3[]) => arc.reduce((sum, q) => sum + q.z, 0) / Math.max(1, arc.length);
  return meanZ(a) >= meanZ(b) ? a : b;
}

function frontArc(H: MochiH, y: number, s: number, roll = false): P3[] {
  const n = 120;
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) {
    const lon = -Math.PI + (i / n) * 2 * Math.PI;
    pts.push((roll ? projRoll : proj)(H, surf(y, lon, s)));
  }
  return frontSilhouetteArc(pts);
}

/** The part of the head above the front arc of ring y: what a cap covers. */
function capClip(H: MochiH, y: number, s: number, extraTop = 3): Path2D {
  const arc = frontArc(H, y, s);
  const p = new Path2D();
  if (!arc.length) return p;
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  p.lineTo(arc[arc.length - 1].x + H.rx, arc[arc.length - 1].y);
  p.lineTo(H.rx * 2, -H.ry * extraTop);
  p.lineTo(-H.rx * 2, -H.ry * extraTop);
  p.closePath();
  return p;
}

/** Everything but `p`, for an even-odd clip. */
function invert(p: Path2D, H: MochiH): Path2D {
  const q = new Path2D();
  q.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  q.addPath(p);
  return q;
}

/** Mochi's silhouette (96 steps), the one outfits clip to. */
export function outfitPath(rx: number, ry: number): Path2D {
  const n = 96, e = 2 / EXP;
  const p = new Path2D();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = rx * (ca >= 0 ? Math.pow(ca, e) : -Math.pow(-ca, e));
    const y = ry * (sa >= 0 ? Math.pow(sa, e) : -Math.pow(-sa, e));
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;
type RGBA = readonly [number, number, number, number];
/** A gradient stop; null is SwiftUI's `.clear`, faded from its neighbours. */
type Stop = readonly [number, RGBA | null];

function hex(h: string, a = 1): RGBA {
  const v = parseInt(h.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a];
}
const rgb = (r: number, g: number, b: number, a = 1): RGBA => [r, g, b, a];
const WHITE = (a: number) => rgb(255, 255, 255, a);
const BLACK = (a: number) => rgb(0, 0, 0, a);
const css = ([r, g, b, a]: RGBA) => `rgba(${r},${g},${b},${a})`;

function addStops(g: CanvasGradient, stops: readonly Stop[]): CanvasGradient {
  stops.forEach(([offset, color], i) => {
    if (color) {
      g.addColorStop(offset, css(color));
      return;
    }
    // Transparent, without a grey fringe: each side fades from its own colour.
    const before = stops.slice(0, i).reverse().find((s) => s[1])?.[1];
    const after = stops.slice(i + 1).find((s) => s[1])?.[1];
    const fade = (c: RGBA | null | undefined) => css(c ? [c[0], c[1], c[2], 0] : [0, 0, 0, 0]);
    g.addColorStop(offset, fade(before ?? after));
    g.addColorStop(offset, fade(after ?? before));
  });
  return g;
}

const linear = (x: Ctx, x0: number, y0: number, x1: number, y1: number, stops: readonly Stop[]) =>
  addStops(x.createLinearGradient(x0, y0, x1, y1), stops);

const radial = (x: Ctx, cx: number, cy: number, r0: number, r1: number, stops: readonly Stop[]) =>
  addStops(x.createRadialGradient(cx, cy, r0, cx, cy, r1), stops);

function fill(x: Ctx, p: Path2D, style: string | CanvasGradient | RGBA, rule?: CanvasFillRule) {
  x.fillStyle = typeof style === "object" && "length" in style ? css(style as RGBA) : (style as string | CanvasGradient);
  if (rule) x.fill(p, rule);
  else x.fill(p);
}

function stroke(x: Ctx, p: Path2D, color: RGBA, width: number, cap: CanvasLineCap = "butt", join: CanvasLineJoin = "miter") {
  x.strokeStyle = css(color);
  x.lineWidth = width;
  x.lineCap = cap;
  x.lineJoin = join;
  x.stroke(p);
}

function polyline(pts: readonly { x: number; y: number }[], dx = 0): Path2D {
  const p = new Path2D();
  pts.forEach((q, i) => (i ? p.lineTo(q.x + dx, q.y) : p.moveTo(q.x + dx, q.y)));
  return p;
}

function line(ax: number, ay: number, bx: number, by: number): Path2D {
  const p = new Path2D();
  p.moveTo(ax, ay);
  p.lineTo(bx, by);
  return p;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Path2D {
  const p = new Path2D();
  p.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
  return p;
}

function roundRect(x: number, y: number, w: number, h: number, r: number): Path2D {
  const p = new Path2D();
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  p.moveTo(x + rr, y);
  p.arcTo(x + w, y, x + w, y + h, rr);
  p.arcTo(x + w, y + h, x, y + h, rr);
  p.arcTo(x, y + h, x, y, rr);
  p.arcTo(x, y, x + w, y, rr);
  p.closePath();
  return p;
}

/** A rectangle far larger than Mochi, to tint whatever the clip lets through. */
function fillAll(x: Ctx, H: MochiH, color: RGBA) {
  const p = new Path2D();
  p.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  fill(x, p, color);
}

function clipped(x: Ctx, clips: readonly (Path2D | [Path2D, CanvasFillRule])[], draw: () => void) {
  x.save();
  for (const c of clips) {
    if (Array.isArray(c)) x.clip(c[0], c[1]);
    else x.clip(c);
  }
  draw();
  x.restore();
}

let layerCanvas: HTMLCanvasElement | null = null;

/** SwiftUI drawLayer at an opacity: draw once, then composite as one picture. */
function withLayer(x: Ctx, alpha: number, draw: (l: Ctx) => void) {
  if (alpha >= 0.995) {
    draw(x);
    return;
  }
  const src = x.canvas as HTMLCanvasElement | undefined;
  if (typeof document !== "undefined" && src && typeof x.getTransform === "function") {
    layerCanvas ??= document.createElement("canvas");
    if (layerCanvas.width !== src.width || layerCanvas.height !== src.height) {
      layerCanvas.width = src.width;
      layerCanvas.height = src.height;
    }
    const l = layerCanvas.getContext("2d");
    if (l) {
      l.setTransform(1, 0, 0, 1, 0, 0);
      l.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
      l.setTransform(x.getTransform());
      draw(l);
      x.save();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalAlpha *= alpha;
      x.drawImage(layerCanvas, 0, 0);
      x.restore();
      return;
    }
  }
  x.save();
  x.globalAlpha *= alpha;
  draw(x);
  x.restore();
}

function drawPompom(x: Ctx, px: number, py: number, r: number, base = hex("#FFFFFF"), shade = rgb(213, 217, 226)) {
  x.save();
  x.translate(px, py);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78, by = Math.sin(a) * r * 0.78;
    fill(x, ellipse(bx, by, br, br), radial(x, bx - br * 0.4, by - br * 0.5, 0, br * 1.3, [[0, base], [1, shade]]));
  }
  fill(x, ellipse(0, 0, r * 0.86, r * 0.86),
    radial(x, -r * 0.3, -r * 0.35, 0, r * 1.05, [[0, base], [0.7, base], [1, shade]]));
  x.restore();
}

function drawFuzzyBand(x: Ctx, arc: P3[], thick: number, base = hex("#FFFFFF"), shade = rgb(218, 221, 228)) {
  if (arc.length < 2) return;
  const p = polyline(arc);
  stroke(x, p, shade, thick, "round", "round");
  stroke(x, p, base, thick * 0.78, "round", "round");
  const step = Math.max(2, Math.floor(arc.length / 16));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i];
    const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    fill(x, ellipse(q.x, q.y - thick * 0.32, r, r),
      radial(x, q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, 0, r * 1.2, [[0, base], [1, shade]]));
  }
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

/** Where Mochi's body is, and how far into the outfit's entrance he is. */
export interface OutfitPose {
  cx: number; cy: number; tilt: number; sx: number; sy: number;
  morph: number; presence: number; rollTurns: number;
}

const HATS = new Set<Outfit>(["beanie", "santaHat", "partyHat", "crown", "witchHat"]);
const CROWN_YB = 0.46;

function bodyTransform(x: Ctx, p: OutfitPose) {
  x.translate(p.cx, p.cy);
  if (p.tilt !== 0) x.rotate(p.tilt);
  x.scale(p.sx, p.sy);
}

/** Hats lift off and swing while Mochi rolls: progress through the roll, 0–1. */
const rollProgress = (H: MochiH, turns: number) =>
  Math.min(1, Math.abs(H.roll) / (2 * Math.PI * Math.max(1, turns)));

function drawHatFront(l: Ctx, outfit: Outfit, H: MochiH, body: Path2D, simplified: boolean) {
  switch (outfit) {
    case "beanie": drawBeanie(l, H, body, simplified); break;
    case "santaHat": drawSantaHat(l, H, body); break;
    case "partyHat": drawPartyHat(l, H, simplified); break;
    case "crown":
      clipped(l, [body, capClip(H, CROWN_YB - 0.1, 1), [invert(capClip(H, CROWN_YB, 1), H), "evenodd"]],
        () => fillAll(l, H, rgb(80, 50, 0, 0.12)));
      drawCrownPart(l, H, 1, simplified);
      break;
    case "witchHat": drawWitchHatFront(l, H, body); break;
  }
}

function drawRollingFront(l: Ctx, outfit: Outfit, H: MochiH, body: Path2D, simplified: boolean) {
  switch (outfit) {
    case "sunglasses": drawSunglasses(l, H, body); break;
    case "roundGlasses": drawRoundGlasses(l, H, body); break;
    case "scarf": drawScarf(l, H); break;
    case "pumpkin": drawPumpkin(l, H, body, simplified); break;
    case "bow": drawBow(l, H); break;
  }
}

/** Everything in front of Mochi's body: hats, glasses, scarf, bow, pumpkin. */
export function drawOutfitFront(x: Ctx, outfit: Outfit, H: MochiH, pose: OutfitPose) {
  if (outfit === "none" || outfit === "auto") return;
  const morphFade = 1 - Math.min(1, Math.max(0, (pose.morph - 0.3) / 0.2));
  if (morphFade <= 0.01) return;
  // Turned away: the behind pass draws it.
  if (outfitFollowsRoll(outfit) && projRoll(H, [0, 0, 1]).z < 0) return;
  const p = pose.presence;
  const posP = Ease.back(p);
  const alpha = morphFade * Math.min(1, p * 2.5);
  if (alpha <= 0.005) return;
  const simplified = H.R < 16;
  const body = outfitPath(H.rx, H.ry);

  x.save();
  bodyTransform(x, pose);
  if (HATS.has(outfit) && Math.abs(H.roll) > 0.01) {
    const u = rollProgress(H, pose.rollTurns);
    x.translate(H.physDx * H.rx * 0.2 * Math.sin(u * Math.PI), -H.ry * 0.45 * Math.sin(u * Math.PI));
    x.rotate(Math.sin(2 * Math.PI * u) * 0.35);
    withLayer(x, alpha, (l) => drawHatFront(l, outfit, H, body, simplified));
    x.restore();
    return;
  }
  const hatScale = 0.85 + 0.15 * posP;
  if (HATS.has(outfit)) {
    x.translate(0, -(1 - posP) * H.ry);
    x.scale(hatScale, hatScale);
    withLayer(x, alpha, (l) => drawHatFront(l, outfit, H, body, simplified));
  } else {
    if (outfit === "sunglasses" || outfit === "roundGlasses") x.translate(0, (1 - p) * 0.25 * H.ry);
    else if (outfit === "scarf") x.translate(0, (1 - p) * 0.3 * H.ry);
    else if (outfit === "bow") x.scale(Math.max(0.001, posP), Math.max(0.001, posP));
    if (outfit !== "bunnyEars") withLayer(x, alpha, (l) => drawRollingFront(l, outfit, H, body, simplified));
  }
  x.restore();
}

/** Everything behind the body: bunny ears, the back of the crown and witch hat,
 *  and accessories turned away while Mochi rolls. */
export function drawOutfitBehind(x: Ctx, outfit: Outfit, H: MochiH, pose: OutfitPose) {
  if (outfit === "none" || outfit === "auto") return;
  const morphFade = 1 - Math.min(1, Math.max(0, (pose.morph - 0.3) / 0.2));
  if (morphFade <= 0.01) return;
  const alpha = morphFade * Math.min(1, pose.presence * 2.5);
  if (alpha <= 0.005) return;
  const simplified = H.R < 16;
  const body = outfitPath(H.rx, H.ry);

  x.save();
  bodyTransform(x, pose);
  if (outfitFollowsRoll(outfit)) {
    if (projRoll(H, [0, 0, 1]).z < 0) {
      withLayer(x, alpha, (l) => drawRollingFront(l, outfit, H, body, simplified));
    }
    x.restore();
    return;
  }
  const posP = Ease.back(pose.presence);
  const hatScale = 0.85 + 0.15 * posP;
  const settle = () => {
    x.translate(0, -(1 - posP) * H.ry);
    x.scale(hatScale, hatScale);
  };
  const lift = () => {
    const u = rollProgress(H, pose.rollTurns);
    x.translate(H.physDx * H.rx * 0.2 * Math.sin(u * Math.PI), -H.ry * 0.45 * Math.sin(u * Math.PI));
    x.rotate(Math.sin(2 * Math.PI * u) * 0.35);
  };
  switch (outfit) {
    case "bunnyEars": {
      // Ears never roll in 3D: they flatten and tilt instead.
      const u = Math.abs(H.roll) > 0.01 ? rollProgress(H, pose.rollTurns) : 0;
      settle();
      withLayer(x, alpha, (l) => drawBunnyEars(l, H, u));
      break;
    }
    case "crown":
      if (Math.abs(H.roll) > 0.01) lift();
      else settle();
      withLayer(x, alpha, (l) => drawCrownPart(l, H, -1, simplified));
      break;
    case "witchHat":
      if (Math.abs(H.roll) > 0.01) lift();
      else settle();
      withLayer(x, alpha, (l) => drawWitchHatBack(l, H));
      break;
  }
  x.restore();
}

// ── Bunny ears ────────────────────────────────────────────────────────────────

function drawBunnyEars(x: Ctx, H: MochiH, rollProgress = 0) {
  const R = H.R;
  const earH = R * 0.85;
  for (const sd of [-1, 1]) {
    const root = proj(H, [sd * 0.45, 0.92, 0]);
    const rootL = proj(H, [sd * 0.45 - 0.22, 0.92, 0]);
    const rootR = proj(H, [sd * 0.45 + 0.22, 0.92, 0]);
    const visHW = Math.max(R * 0.04, Math.abs(rootR.x - rootL.x) / 2);
    const flatten = Math.sin(rollProgress * Math.PI);
    const effH = earH * (1 - 0.8 * flatten);
    x.save();
    x.translate(root.x, root.y - effH * 0.65 + effH * 0.5);
    x.rotate(sd * 0.6 * flatten);
    const outer = ellipse(0, 0, visHW, effH / 2);
    fill(x, outer, hex("#F9F0F0"));
    stroke(x, outer, BLACK(0.06), 0.8);
    fill(x, ellipse(0, -effH / 2 + R * 0.1 + effH * 0.325, visHW * 0.5, effH * 0.325), hex("#FCA5A5", 0.7));
    x.restore();
  }
}

// ── Beanie ────────────────────────────────────────────────────────────────────

function drawBeanie(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  const s = 1.035, yEdge = 0.42, yCuff = 0.58;
  const head = outfitPath(H.rx * s, H.ry * s);

  // Shadow on the head under the cuff.
  clipped(x, [body, capClip(H, yEdge - 0.12, 1)], () => fillAll(x, H, rgb(30, 40, 70, 0.1)));

  // Knit body, and its vertical ribs.
  clipped(x, [capClip(H, yCuff, s)], () => {
    fill(x, head, linear(x, H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2,
      [[0, hex("#7DB6FF")], [1, hex("#2F6FE0")]]));
    if (simplified) return;
    clipped(x, [head], () => {
      for (let k = -6; k <= 6; k++) {
        const lon = k * 0.24;
        const pts: P3[] = [];
        for (let i = 0; i <= 16; i++) {
          const q = proj(H, surf(yCuff + ((1.05 - yCuff) * i) / 16, lon, s));
          if (q.z > 0) pts.push(q);
        }
        if (pts.length >= 2) stroke(x, polyline(pts), rgb(20, 50, 140, 0.16), H.R * 0.045, "round");
      }
    });
  });

  // Folded cuff: the band between yEdge and yCuff.
  const cuffHead = outfitPath(H.rx * s * 1.04, H.ry * s * 1.04);
  clipped(x, [capClip(H, yEdge, s * 1.04), [invert(capClip(H, yCuff, s * 1.04), H), "evenodd"]], () => {
    fill(x, cuffHead, linear(x, 0, -H.ry * 0.6, 0, -H.ry * 0.2, [[0, hex("#3C7BEA")], [1, hex("#2257C4")]]));
    clipped(x, [cuffHead], () => {
      for (let k = -14; k <= 14; k++) {
        const lon = k * 0.115;
        const a = proj(H, surf(yEdge, lon, s * 1.04));
        const b = proj(H, surf(yCuff, lon, s * 1.04));
        if (a.z < 0) continue;
        stroke(x, line(a.x, a.y, b.x, b.y), rgb(10, 30, 100, 0.22), H.R * 0.035, "butt");
      }
    });
  });

  // Top highlight.
  clipped(x, [capClip(H, yCuff, s), head], () =>
    fill(x, head, radial(x, H.rx * 0.3, -H.ry * 0.85, 0, H.R * 0.45, [[0, WHITE(0.35)], [1, null]])));

  // Pompom on a short spring.
  const top = proj(H, [0, 1.08 * s, 0]);
  drawPompom(x, top.x + H.physDx * H.rx * 0.25, top.y - H.R * 0.12 + H.physDy * H.ry * 0.15, H.R * 0.24);
}

// ── Santa hat ─────────────────────────────────────────────────────────────────

function drawSantaHat(x: Ctx, H: MochiH, body: Path2D) {
  const s = 1.05, yEdge = 0.52;
  const arc = frontArc(H, yEdge, s);
  if (!arc.length) return;
  const L = arc[0], Rt = arc[arc.length - 1];
  const crown = proj(H, [0, 1.05, 0]);
  // The tip flops to the right and lags behind on its spring.
  const tip = { x: crown.x + H.rx * (0.95 + H.physDx * 0.35), y: crown.y + H.ry * (0.05 + H.physDy * 0.2) };
  const peak = { x: crown.x + H.rx * 0.25, y: crown.y - H.ry * 0.62 };

  const bag = new Path2D();
  bag.moveTo(L.x, L.y);
  bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
  bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
  for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
  bag.closePath();

  clipped(x, [body, capClip(H, yEdge - 0.14, 1)], () => fillAll(x, H, rgb(120, 10, 10, 0.1)));

  fill(x, bag, linear(x, -H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3,
    [[0, hex("#FF6B6B")], [0.55, hex("#E53935")], [1, hex("#B71C1C")]]));

  clipped(x, [bag], () => {
    for (const [a, b, w] of [[0.15, 0.55, 0.1], [0.45, 0.85, 0.08]]) {
      const fold = new Path2D();
      fold.moveTo(peak.x - H.rx * 0.1 + (Rt.x - L.x) * a * 0.3, peak.y + H.ry * 0.15);
      fold.quadraticCurveTo(peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3),
        tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12);
      stroke(x, fold, rgb(90, 0, 0, 0.2), H.R * w, "round");
    }
    fill(x, bag, radial(x, peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, 0, H.R * 0.5, [[0, WHITE(0.32)], [1, null]]));
  });

  drawFuzzyBand(x, arc, H.R * 0.3);
  drawPompom(x, tip.x, tip.y + H.R * 0.04, H.R * 0.22);
}

// ── Party hat ─────────────────────────────────────────────────────────────────

function drawPartyHat(x: Ctx, H: MochiH, simplified: boolean) {
  const baseY = 0.82, baseR = 0.42;
  const lean = -0.24 + H.physDx * 0.12;
  const c = proj(H, [0.16, baseY + 0.06, 0]);
  const ring: P3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(proj(H, [0.16 + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)]));
  }
  const left = ring.reduce((m, q) => (q.x < m.x ? q : m));
  const right = ring.reduce((m, q) => (q.x > m.x ? q : m));
  const h = H.ry * 1.6;
  const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
  const front = frontSilhouetteArc(ring);

  const cone = new Path2D();
  cone.moveTo(left.x, left.y);
  cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
  for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
  cone.closePath();

  fill(x, cone, linear(x, left.x, apex.y, right.x, left.y,
    [[0, hex("#FF9BD0")], [0.5, hex("#F15BAE")], [1, hex("#C2187A")]]));

  clipped(x, [cone], () => {
    if (!simplified) {
      const dots: [number, number][] = [
        [0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28], [0.8, -0.3], [0.45, 0.6], [0.48, -0.65],
      ];
      for (const [t, u] of dots) {
        const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
        const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
        const r = H.R * 0.075 * (0.6 + t * 0.5);
        fill(x, ellipse(bx + (apex.x - bx) * (1 - t), by + (apex.y - by) * (1 - t), r, r * 0.9), WHITE(0.92));
      }
    }
    fill(x, cone, linear(x, left.x, 0, right.x, 0, [[0, WHITE(0.28)], [0.35, null], [1, rgb(80, 0, 40, 0.18)]]));
  });

  if (front.length) stroke(x, polyline(front), hex("#FFD84D"), H.R * 0.07, "round");
  drawPompom(x, apex.x, apex.y - H.R * 0.04, H.R * 0.16, hex("#FFE27A"), hex("#F2B705"));
}

// ── Crown ─────────────────────────────────────────────────────────────────────

/** side 1: the front half, gold; side −1: the back half, darker, behind the body. */
function drawCrownPart(x: Ctx, H: MochiH, side: number, simplified: boolean) {
  const s = 1.06, yb = 0.46, yt = 0.66, n = 8, spikeH = 0.42, N = 120;
  const seg: { b: P3; tt: P3; z: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + (i / N) * 2 * Math.PI;
    const b = proj(H, surf(yb, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const f = phase - Math.floor(phase);
    const spike = Math.pow(Math.max(0, 1 - Math.abs(f - 0.5) * 2), 1.6);
    const sp = surf(yt, lon, s);
    const tt = proj(H, [sp[0] * (1 - 0.08 * spike), yt + spikeH * spike, sp[2] * (1 - 0.08 * spike)]);
    seg.push({ b, tt, z: b.z });
  }
  const keep = seg.filter((q) => (side > 0 ? q.z >= 0 : q.z < 0.02)).sort((a, b) => a.b.x - b.b.x);
  if (keep.length < 2) return;

  const shape = new Path2D();
  shape.moveTo(keep[0].tt.x, keep[0].tt.y);
  for (let i = 1; i < keep.length; i++) shape.lineTo(keep[i].tt.x, keep[i].tt.y);
  for (let i = keep.length - 1; i >= 0; i--) shape.lineTo(keep[i].b.x, keep[i].b.y);
  shape.closePath();

  const dark = side < 0;
  fill(x, shape, linear(x, 0, -H.ry * 1.05, 0, -H.ry * 0.45, dark
    ? [[0, hex("#C98A12")], [1, hex("#8A5A06")]]
    : [[0, hex("#FFE58A")], [0.5, hex("#FBBF24")], [1, hex("#D08A0B")]]));
  if (dark) return;

  clipped(x, [shape], () => fill(x, shape, linear(x, -H.rx, 0, H.rx, 0, [
    [0, rgb(120, 70, 0, 0.25)], [0.45, WHITE(0)], [0.62, WHITE(0.35)], [1, rgb(120, 70, 0, 0.25)],
  ])));
  if (simplified) return;

  const gems = ["#EF4444", "#3B82F6", "#22C55E", "#A855F7"];
  for (let k = 0; k < n; k++) {
    const lon = -Math.PI + ((k + 0.5) / n) * 2 * Math.PI;
    const sp = surf(yt, lon, s);
    const tipP = proj(H, [sp[0] * 0.92, yt + spikeH, sp[2] * 0.92]);
    const mid = proj(H, surf((yb + yt) / 2, lon, s * 1.01));
    if (mid.z <= 0.12) continue;
    const r = H.R * 0.055;
    fill(x, ellipse(tipP.x, tipP.y - r * 0.5, r, r),
      radial(x, tipP.x - r * 0.3, tipP.y - r, 0, r * 1.2, [[0, hex("#FFF6CC")], [1, hex("#E0A21A")]]));
    const gr = H.R * 0.075;
    fill(x, ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr), hex(gems[k % gems.length]));
    fill(x, ellipse(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, gr * 0.28), WHITE(0.75));
  }
}

// ── Witch hat ─────────────────────────────────────────────────────────────────

function witchBrimPts(H: MochiH): P3[] {
  const y = 0.7, rr = 1.42;
  const pts: P3[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = -Math.PI + (i / 120) * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.1 * Math.pow(Math.abs(Math.sin(a)), 2);
    pts.push(proj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]));
  }
  return pts;
}

function drawWitchHatBack(x: Ctx, H: MochiH) {
  const pts = witchBrimPts(H);
  if (!pts.some((q) => q.z < 0.05)) return;
  const brim = polyline(pts);
  brim.closePath();
  fill(x, brim, linear(x, 0, -H.ry, 0, -H.ry * 0.4, [[0, hex("#2A0A4F")], [1, hex("#3B0F6B")]]));
}

function drawWitchHatFront(x: Ctx, H: MochiH, body: Path2D) {
  const all = witchBrimPts(H);
  const brim = polyline(all);
  brim.closePath();
  const fr = all.filter((q) => q.z >= 0).sort((a, b) => a.x - b.x);

  clipped(x, [body, capClip(H, 0.5, 1)], () => fillAll(x, H, rgb(40, 0, 70, 0.1)));

  fill(x, brim, linear(x, 0, -H.ry * 0.9, 0, -H.ry * 0.3, [[0, hex("#5B21B6")], [1, hex("#3B0764")]]));
  if (fr.length) stroke(x, polyline(fr), rgb(190, 150, 255, 0.35), H.R * 0.035, "round");

  // Cone.
  const baseR = 0.62, by = 0.74;
  const bl = proj(H, [-baseR, by, 0]);
  const br = proj(H, [baseR, by, 0]);
  const c = proj(H, [0, by, 0]);
  const lean = 0.1 + H.physDx * 0.15;
  const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
  const tip = { x: top.x + H.rx * (0.45 + H.physDx * 0.25), y: top.y + H.ry * (0.22 + H.physDy * 0.1) };
  const capFront = frontArc(H, by, baseR / ringR(by)).filter((q) => q.x >= bl.x - 1 && q.x <= br.x + 1);

  const cone = new Path2D();
  cone.moveTo(bl.x, bl.y);
  cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25,
    top.x - H.rx * 0.02, top.y - H.ry * 0.02);
  cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
  cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
  cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
  for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y);
  cone.closePath();

  fill(x, cone, linear(x, bl.x, top.y, br.x, bl.y, [[0, hex("#7C3AED")], [0.55, hex("#4C1D95")], [1, hex("#2E1065")]]));

  clipped(x, [cone], () => {
    fill(x, cone, linear(x, bl.x, 0, br.x, 0, [[0, WHITE(0.22)], [0.4, null], [1, BLACK(0.15)]]));
    const crease = new Path2D();
    crease.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05);
    crease.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
    stroke(x, crease, rgb(20, 0, 40, 0.35), H.R * 0.05, "round");
    // Orange band.
    const fc = proj(H, [0, by, baseR]);
    const lift = H.ry * 0.11;
    const band = new Path2D();
    band.moveTo(bl.x - 2, bl.y - lift);
    band.quadraticCurveTo(fc.x, 2 * (fc.y - lift) - (bl.y + br.y) / 2, br.x + 2, br.y - lift);
    stroke(x, band, hex("#F97316"), H.ry * 0.17, "butt");
  });

  // Buckle.
  const bk = proj(H, [0, by, baseR]);
  const bw = H.R * 0.2, bh = H.R * 0.16;
  x.save();
  x.translate(bk.x, bk.y - H.ry * 0.11);
  fill(x, roundRect(-bw / 2, -bh / 2, bw, bh, bh * 0.25), hex("#FCD34D"));
  fill(x, roundRect(-bw / 2 + bw * 0.24, -bh / 2 + bh * 0.28, bw * 0.52, bh * 0.44, bh * 0.1), hex("#C2410C"));
  x.restore();
}

// ── Glasses ───────────────────────────────────────────────────────────────────

/** The eyes as the glasses see them: roll folded into pitch, so they stay on. */
const rolledEyes = (H: MochiH) => eyeFrames(mochiH(H.R, H.yaw, H.pitch + H.roll, H.physDx, H.physDy));

function drawSunglasses(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = rolledEyes(H);
  const w = H.R * 0.62, h = H.R * 0.46;
  const frame = hex("#111317");
  clipped(x, [body], () => {
    const [le, re] = eyes;
    if (le.visible && re.visible) {
      const bridge = new Path2D();
      bridge.moveTo(le.x + (w / 2) * le.fx * 0.9, le.y - h * 0.18);
      bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - h * 0.42, re.x - (w / 2) * re.fx * 0.9, re.y - h * 0.18);
      stroke(x, bridge, frame, H.R * 0.07, "round");
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      const ox = e.x + e.sd * (w / 2) * e.fx;
      stroke(x, line(ox, e.y - h * 0.2, e.sd * H.rx * 1.05, e.y - h * 0.35), frame, H.R * 0.06, "round");
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      x.save();
      x.translate(e.x, e.y);
      x.scale(e.fx, e.fy);
      const lens = roundRect(-w / 2, -h / 2, w, h, h * 0.42);
      fill(x, lens, rgb(17, 19, 23, 0.82));
      stroke(x, lens, hex("#0B0C0F"), H.R * 0.05);
      stroke(x, line(-w * 0.28, -h * 0.05, -w * 0.05, -h * 0.3), WHITE(0.45), H.R * 0.05, "round");
      x.restore();
    }
  });
}

function drawRoundGlasses(x: Ctx, H: MochiH, body: Path2D) {
  const eyes = rolledEyes(H);
  const d = H.R * 0.56;
  const frame = hex("#8A4B12");
  clipped(x, [body], () => {
    const [le, re] = eyes;
    if (le.visible && re.visible) {
      const bridge = new Path2D();
      bridge.moveTo(le.x + (d / 2) * le.fx, le.y - d * 0.08);
      bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - d * 0.3, re.x - (d / 2) * re.fx, re.y - d * 0.08);
      stroke(x, bridge, frame, H.R * 0.055, "round");
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      stroke(x, line(e.x + e.sd * (d / 2) * e.fx, e.y - d * 0.1, e.sd * H.rx * 1.05, e.y - d * 0.25), frame, H.R * 0.05, "round");
    }
    for (const e of eyes) {
      if (!e.visible) continue;
      x.save();
      x.translate(e.x, e.y);
      x.scale(e.fx, e.fy);
      const circle = ellipse(0, 0, d / 2, d / 2);
      fill(x, circle, rgb(190, 225, 255, 0.18));
      stroke(x, circle, hex("#9A5A1A"), H.R * 0.065, "round");
      const glint = new Path2D();
      glint.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45, false);
      stroke(x, glint, WHITE(0.55), H.R * 0.03, "round");
      x.restore();
    }
  });
}

// ── Scarf ─────────────────────────────────────────────────────────────────────

function drawScarf(x: Ctx, H: MochiH) {
  const s = 1.05, y0 = -0.34, y1 = -0.66;
  const top = frontArc(H, y0, s, true);
  const bot = frontArc(H, y1, s, true);
  if (!top.length || !bot.length) return;

  const band = polyline(top);
  for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
  band.closePath();

  clipped(x, [outfitPath(H.rx * s, H.ry * s)], () => {
    fill(x, band, linear(x, 0, -H.ry * 0.2, 0, H.ry * 0.7, [[0, hex("#F87171")], [1, hex("#B91C1C")]]));
    clipped(x, [band], () => {
      for (const lon of [-1, -0.45, 0.1, 0.65, 1.2]) {
        const a = proj(H, surf(y0, lon, s));
        const b = proj(H, surf(y1, lon, s));
        if (a.z < 0) continue;
        stroke(x, line(a.x, a.y - 4, b.x, b.y + 4), WHITE(0.85), H.R * 0.09 * Math.max(0.3, a.z), "round");
      }
    });
    fill(x, band, linear(x, 0, -H.ry * 0.5, 0, H.ry * 0.3, [[0, WHITE(0.18)], [1, BLACK(0.1)]]));
  });

  // The hanging end swings with Mochi.
  const k = proj(H, surf((y0 + y1) / 2, -0.55, s * 1.03));
  if (k.z <= 0) return;
  const R = H.R;
  const sw = H.physDx * H.rx * 0.12;
  const end = new Path2D();
  end.moveTo(k.x - R * 0.16, k.y);
  end.quadraticCurveTo(k.x - R * 0.24 + sw, k.y + H.ry * 0.35, k.x - R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
  end.lineTo(k.x + R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
  end.quadraticCurveTo(k.x + R * 0.02 + sw, k.y + H.ry * 0.3, k.x + R * 0.12, k.y);
  end.closePath();
  fill(x, end, linear(x, 0, k.y, 0, k.y + H.ry * 0.6, [[0, hex("#EF4444")], [1, hex("#B91C1C")]]));
  clipped(x, [end], () => {
    for (const t of [0.35, 0.7]) {
      const stripe = new Path2D();
      stripe.rect(k.x - R * 0.4 + sw, k.y + H.ry * 0.62 * t, R * 0.8, R * 0.07);
      fill(x, stripe, WHITE(0.85));
    }
  });
  for (let i = 0; i < 4; i++) {
    const fx = k.x - R * 0.17 + sw * 1.4 + i * R * 0.075;
    stroke(x, line(fx, k.y + H.ry * 0.6, fx, k.y + H.ry * 0.72), hex("#DC2626"), R * 0.035, "round");
  }
  x.save();
  x.translate(k.x, k.y);
  x.rotate(0.2);
  fill(x, ellipse(0, 0, R * 0.17, R * 0.14), radial(x, -R * 0.05, -R * 0.05, 0, R * 0.2, [[0, hex("#F87171")], [1, hex("#B91C1C")]]));
  x.restore();
}

// ── Pumpkin ───────────────────────────────────────────────────────────────────

/** Ribs, stem and leaf; the body itself turns orange in the engine. */
function drawPumpkin(x: Ctx, H: MochiH, body: Path2D, simplified: boolean) {
  const R = H.R;
  if (!simplified) {
    clipped(x, [body], () => {
      for (const lon of [-1.15, -0.55, 0, 0.55, 1.15]) {
        const pts: P3[] = [];
        for (let i = 0; i <= 30; i++) {
          const q = projRoll(H, surf(-0.98 + (1.96 * i) / 30, lon, 1));
          if (q.z > 0) pts.push(q);
        }
        if (pts.length < 2) continue;
        const zz = pts[Math.floor(pts.length / 2)].z;
        stroke(x, polyline(pts), rgb(150, 50, 0, 0.22 * zz), R * 0.12, "round");
        stroke(x, polyline(pts, R * 0.07), rgb(255, 220, 170, 0.18 * zz), R * 0.04, "round");
      }
    });
  }

  const t = projRoll(H, [0.02, 1.0, 0]);
  const stem = new Path2D();
  stem.moveTo(t.x - R * 0.09, t.y + R * 0.04);
  stem.quadraticCurveTo(t.x - R * 0.08, t.y - R * 0.22, t.x + R * 0.08, t.y - R * 0.3);
  stem.lineTo(t.x + R * 0.13, t.y - R * 0.22);
  stem.quadraticCurveTo(t.x + R * 0.04, t.y - R * 0.15, t.x + R * 0.08, t.y + R * 0.04);
  stem.closePath();
  fill(x, stem, linear(x, t.x - R * 0.1, 0, t.x + R * 0.1, 0, [[0, hex("#65A30D")], [1, hex("#3F6212")]]));

  x.save();
  x.translate(t.x - R * 0.06, t.y - R * 0.02);
  x.rotate(-0.5);
  const leaf = new Path2D();
  leaf.moveTo(0, 0);
  leaf.quadraticCurveTo(-R * 0.18, -R * 0.2, -R * 0.38, -R * 0.02);
  leaf.quadraticCurveTo(-R * 0.18, R * 0.1, 0, 0);
  fill(x, leaf, linear(x, 0, -R * 0.15, -R * 0.3, 0, [[0, hex("#84CC16")], [1, hex("#4D7C0F")]]));
  const vein = new Path2D();
  vein.moveTo(-R * 0.02, -R * 0.01);
  vein.quadraticCurveTo(-R * 0.18, -R * 0.08, -R * 0.32, -R * 0.03);
  stroke(x, vein, rgb(30, 60, 0, 0.4), R * 0.02, "round");
  x.restore();

  if (!simplified) {
    const tendril = new Path2D();
    tendril.moveTo(t.x + R * 0.1, t.y - R * 0.12);
    tendril.bezierCurveTo(t.x + R * 0.3, t.y - R * 0.25, t.x + R * 0.35, t.y - R * 0.02, t.x + R * 0.22, t.y - R * 0.06);
    stroke(x, tendril, hex("#4D7C0F"), R * 0.03, "round");
  }
}

// ── Bow ───────────────────────────────────────────────────────────────────────

function drawBow(x: Ctx, H: MochiH) {
  const a = projRoll(H, surf(0.86, 0.55, 1.02));
  if (a.z < -0.2) return;
  const s = H.R * 0.26;
  x.save();
  x.translate(a.x, a.y);
  x.rotate(0.35 + H.yaw * 0.3);
  x.scale(Math.max(0.45, Math.cos(0.55 + H.yaw)), 1);
  for (const sd of [-1, 1]) {
    const wing = new Path2D();
    wing.moveTo(0, 0);
    wing.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
    wing.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
    fill(x, wing, linear(x, 0, -s, 0, s, [[0, hex("#FF8CC6")], [1, hex("#DB2777")]]));
    const crease = new Path2D();
    crease.moveTo(sd * s * 0.25, -s * 0.05);
    crease.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
    stroke(x, crease, rgb(140, 10, 70, 0.35), s * 0.08, "round");
  }
  fill(x, ellipse(0, 0, s * 0.24, s * 0.3), radial(x, -s * 0.06, -s * 0.1, 0, s * 0.35, [[0, hex("#FFB3D9")], [1, hex("#C2185B")]]));
  x.restore();
}

// ── Wardrobe icons ────────────────────────────────────────────────────────────

const ICON_INK = rgb(26, 21, 18);

/** A small Mochi wearing `outfit` (Auto: today's outfit plus an AUTO tag), in a
 *  `size`×`size` square: drawOutfitIcon from IslandViewContent.swift. */
export function drawOutfitIcon(x: Ctx, size: number, outfit: Outfit, seasonal: Outfit = "none") {
  const cx = size / 2, cy = size / 2;
  if (outfit === "none") {
    const R = 6.5;
    x.save();
    x.translate(cx, cy);
    stroke(x, ellipse(0, 0, R * 0.82, R * 0.82), hex("#454850"), 1.4, "round");
    stroke(x, line(-R * 0.56, R * 0.56, R * 0.56, -R * 0.56), hex("#454850"), 1.4, "round");
    x.restore();
    return;
  }
  const iconR = 10;
  const H = mochiH(iconR);
  const body = outfitPath(H.rx, H.ry);
  const iconCY = cy + iconR * 0.62;
  const worn = outfit === "auto" ? seasonal : outfit;
  const wearing = worn !== "none" && worn !== "auto";
  const pose: OutfitPose = { cx, cy: iconCY, tilt: 0, sx: 1, sy: 1, morph: 0, presence: 1, rollTurns: 1 };

  if (wearing) drawOutfitBehind(x, worn, H, pose);
  x.save();
  x.translate(cx, iconCY);
  const pumpkin = worn === "pumpkin";
  fill(x, body, linear(x, H.rx * 0.7, -H.ry * 0.85, -H.rx * 0.8, H.ry * 0.9, [
    [0, pumpkin ? hex("#FFA94D") : hex("#EDEDEF")], [1, pumpkin ? hex("#E8590C") : hex("#C4C5CA")],
  ]));
  fill(x, body, radial(x, 0, 0, iconR * 0.15, iconR * 1.25, [[0, null], [0.6, null], [1, BLACK(0.2)]]));
  if (outfit !== "auto") {
    fill(x, body, radial(x, H.rx * 0.34, -H.ry * 0.46, 0, iconR * 0.42, [[0, WHITE(0.55)], [1, null]]));
  }
  clipped(x, [body], () => {
    for (const f of eyeFrames(H)) {
      if (!f.visible) continue;
      x.save();
      x.translate(f.x, f.y);
      x.scale(f.fx, f.fy);
      const hh = Math.max(f.h, f.w * 0.3);
      fill(x, roundRect(-f.w / 2, -hh / 2, f.w, hh, Math.min(f.w / 2, hh / 2)), ICON_INK);
      x.restore();
    }
  });
  x.restore();
  if (wearing) drawOutfitFront(x, worn, H, pose);

  if (outfit === "auto") {
    x.save();
    x.translate(cx, iconCY + H.ry * 0.72);
    fill(x, roundRect(-7, -3.25, 14, 6.5, 3.25), BLACK(0.6));
    x.fillStyle = "#FFFFFF";
    x.font = `600 4.2px system-ui, "Segoe UI", sans-serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText("AUTO", 0, 0.2);
    x.restore();
  }
}
