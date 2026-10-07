import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Mochi's wardrobe (upstream #195): the seasonal rules from MochiWardrobeTests,
// every outfit drawn without bad geometry, the engine's transitions, and the
// wardrobe view. Canvas, Path2D and the DOM are small stand-ins.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

const finite = (...v) => {
  for (const n of v) if (!Number.isFinite(n)) throw new Error(`non-finite coordinate ${n}`);
};
class Path2D {
  constructor() { this.ops = 0; }
  moveTo(x, y) { finite(x, y); this.ops++; }
  lineTo(x, y) { finite(x, y); this.ops++; }
  closePath() {}
  bezierCurveTo(...v) { finite(...v); this.ops++; }
  quadraticCurveTo(...v) { finite(...v); this.ops++; }
  arc(x, y, r, a0, a1) { finite(x, y, r, a0, a1); if (r < 0) throw new Error('negative arc radius'); this.ops++; }
  arcTo(x1, y1, x2, y2, r) { finite(x1, y1, x2, y2, r); if (r < 0) throw new Error('negative arcTo radius'); this.ops++; }
  ellipse(x, y, rx, ry, rot, a0, a1) { finite(x, y, rx, ry); if (rx < 0 || ry < 0) throw new Error('negative ellipse radius'); this.ops++; }
  rect(...v) { finite(...v); this.ops++; }
  addPath() {}
}

function fakeCtx() {
  const calls = { fill: 0, stroke: 0, text: 0, clip: 0, save: 0, restore: 0 };
  const gradient = { addColorStop(offset) { finite(offset); if (offset < 0 || offset > 1) throw new Error('stop offset'); } };
  const state = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'fill' || prop === 'stroke' || prop === 'clip' || prop === 'save' || prop === 'restore') {
        return () => { calls[prop]++; };
      }
      if (prop === 'fillText') return () => { calls.text++; };
      if (prop === 'createLinearGradient') return (...v) => { finite(...v); return gradient; };
      if (prop === 'createRadialGradient') return (x0, y0, r0, x1, y1, r1) => {
        finite(x0, y0, r0, x1, y1, r1);
        if (r0 < 0 || r1 < 0) throw new Error('negative gradient radius');
        return gradient;
      };
      if (prop === 'translate' || prop === 'scale' || prop === 'rotate') return (...v) => finite(...v);
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, calls };
}

function load(file, stubs = {}, cache = new Map(), extra = {}) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, console, Math, Date, Path2D,
    performance: extra.performance ?? performance,
    setTimeout: extra.setTimeout ?? (() => 0),
    clearTimeout: () => {},
    window: extra.window ?? { setTimeout: () => 0, clearTimeout() {}, devicePixelRatio: 1 },
    ...extra.globals,
    require: (name) => {
      if (name.startsWith('@tauri-apps/')) return {};
      for (const [suffix, value] of Object.entries(stubs)) if (name.endsWith(suffix)) return value;
      return load(resolve(dirname(file), `${name}.ts`), stubs, cache, extra);
    },
  }, { filename: file });
  return exports;
}

const outfits = () => load(resolve(root, 'mochi/outfits.ts'));

test('the seasons dress Mochi as on macOS', () => {
  const { seasonalOutfit, resolveOutfit, easterDate, parseOutfit } = outfits();
  const on = (y, m, d) => seasonalOutfit(new Date(y, m - 1, d, 15, 30));
  const cases = [
    [2026, 9, 30, 'none'], [2026, 10, 1, 'witchHat'], [2026, 10, 31, 'witchHat'], [2026, 11, 1, 'witchHat'],
    [2026, 11, 2, 'none'], [2026, 11, 30, 'none'], [2026, 12, 1, 'santaHat'], [2026, 12, 26, 'santaHat'],
    [2026, 12, 27, 'none'], [2026, 12, 30, 'none'], [2026, 12, 31, 'partyHat'], [2027, 1, 1, 'partyHat'],
    [2027, 1, 2, 'partyHat'], [2027, 1, 3, 'none'], [2026, 2, 13, 'none'], [2026, 2, 16, 'none'],
    // Easter 2026 is 5 April: Good Friday to Easter Monday.
    [2026, 4, 2, 'none'], [2026, 4, 3, 'bunnyEars'], [2026, 4, 4, 'bunnyEars'], [2026, 4, 5, 'bunnyEars'],
    [2026, 4, 6, 'bunnyEars'], [2026, 4, 7, 'none'],
    [2027, 3, 26, 'bunnyEars'], [2027, 3, 29, 'bunnyEars'], [2027, 3, 30, 'none'],
    [2028, 4, 14, 'bunnyEars'], [2028, 4, 17, 'bunnyEars'], [2028, 4, 18, 'none'],
    [2026, 6, 20, 'none'], [2026, 6, 21, 'sunglasses'], [2026, 8, 31, 'sunglasses'], [2026, 9, 1, 'none'],
  ];
  for (const [y, m, d, want] of cases) assert.equal(on(y, m, d), want, `${y}-${m}-${d}`);
  // The day, not the hour: Easter Thursday evening is still plain Mochi.
  assert.equal(seasonalOutfit(new Date(2026, 3, 2, 23, 59)), 'none');
  assert.deepEqual(Array.from(easterDate(2026)), [4, 5]);
  assert.deepEqual(Array.from(easterDate(2027)), [3, 28]);
  const october = new Date(2026, 9, 15);
  assert.equal(resolveOutfit('auto', october), 'witchHat');
  assert.equal(resolveOutfit('none', october), 'none');
  assert.equal(resolveOutfit('beanie', october), 'beanie');
  assert.equal(parseOutfit('crown'), 'crown');
  assert.equal(parseOutfit('heartsHeadband'), 'auto', 'unknown names fall back to Auto');
  assert.equal(parseOutfit(undefined), 'auto');
});

test('every outfit draws, front and behind, entering, rolling, turned away and tiny', () => {
  const { OUTFITS, drawOutfitFront, drawOutfitBehind, drawOutfitIcon, mochiH } = outfits();
  assert.equal(OUTFITS.length, 13);
  const poses = [
    { R: 17.4, yaw: 0, pitch: 0, roll: 0, presence: 1 },
    { R: 17.4, yaw: 0.55, pitch: -0.3, roll: 0, presence: 0.3 },
    { R: 17.4, yaw: -0.6, pitch: 0.25, roll: 2.4, presence: 1 },
    { R: 17.4, yaw: 0, pitch: 0, roll: Math.PI, presence: 1 },
    { R: 6, yaw: 0.2, pitch: 0, roll: 0, presence: 1 },
  ];
  for (const outfit of OUTFITS) {
    let drawn = 0;
    for (const p of poses) {
      const H = mochiH(p.R, p.yaw, p.pitch, 0.4, -0.2, p.roll);
      const pose = { cx: 50, cy: 70, tilt: 0.1, sx: 1.02, sy: 0.98, morph: 0, presence: p.presence, rollTurns: 1 };
      const { ctx, calls } = fakeCtx();
      drawOutfitBehind(ctx, outfit, H, pose);
      drawOutfitFront(ctx, outfit, H, pose);
      assert.equal(calls.save, calls.restore, `${outfit}: save/restore balance`);
      drawn += calls.fill + calls.stroke;
    }
    if (outfit === 'none' || outfit === 'auto') assert.equal(drawn, 0, `${outfit} draws nothing on Mochi`);
    else assert.ok(drawn > 0, `${outfit} draws`);
    const { ctx, calls } = fakeCtx();
    drawOutfitIcon(ctx, 30, outfit, 'witchHat');
    assert.ok(calls.fill + calls.stroke > 0, `${outfit} icon`);
    assert.equal(calls.text, outfit === 'auto' ? 1 : 0, 'only Auto carries its tag');
  }
  // Morphed into the mailbox, he wears nothing.
  const { ctx, calls } = fakeCtx();
  const pose = { cx: 50, cy: 70, tilt: 0, sx: 1, sy: 1, morph: 0.9, presence: 1, rollTurns: 1 };
  drawOutfitFront(ctx, 'crown', mochiH(17), pose);
  assert.equal(calls.fill, 0);
});

function engineFixture() {
  const clock = { t: 1000 };
  const sounds = [];
  const extra = { performance: { now: () => clock.t } };
  const { BotEngine } = load(resolve(root, 'mochi/engine.ts'),
    { '/sound': { Sound: { play: (s) => sounds.push(s) } } }, new Map(), extra);
  return { engine: new BotEngine(), clock, sounds };
}

test('outfits come on, change and go with the macOS timings', () => {
  const { engine, clock } = engineFixture();
  const step = (ms) => { clock.t += ms; engine.update(ms / 1000); };
  engine.setOutfit('beanie');
  assert.equal(engine.outfit, 'beanie');
  assert.equal(engine.outfitPresence, 0);
  step(200);
  assert.ok(engine.outfitPresence > 0 && engine.outfitPresence < 1);
  step(200);
  assert.equal(engine.outfitPresence, 1);
  // A change takes the old one off first (180 ms), then puts the new one on (350 ms).
  engine.setOutfit('crown');
  step(100);
  assert.equal(engine.outfit, 'beanie');
  step(100);
  assert.equal(engine.outfit, 'crown');
  step(400);
  assert.equal(engine.outfitPresence, 1);
  // Asking again for the same outfit changes nothing.
  engine.setOutfit('crown');
  assert.equal(engine.outfitPresence, 1);
  engine.setOutfit('none');
  step(200);
  assert.equal(engine.outfit, 'none');
  assert.equal(engine.outfitPresence, 0);
  // In the wardrobe it is instant.
  engine.setOutfit('pumpkin', false);
  assert.equal(engine.outfit, 'pumpkin');
  assert.equal(engine.outfitPresence, 1);
});

test('a turn of the head swings the soft parts, which settle again', () => {
  const { engine, clock } = engineFixture();
  engine.setOutfit('santaHat', false);
  const step = (ms) => { clock.t += ms; engine.update(ms / 1000); };
  step(16);
  engine.anim('yaw', [[0.6, 200, (t) => t]]);
  let peak = 0;
  for (let i = 0; i < 20; i++) { step(16); peak = Math.max(peak, Math.abs(engine.physDx)); }
  assert.ok(peak > 0.2, `the hat tip lags behind (${peak})`);
  for (let i = 0; i < 200; i++) step(16);
  assert.ok(Math.abs(engine.physDx) < 0.02, `and comes back (${engine.physDx})`);
  // Drawing a dressed Mochi mid-roll turns the whole body; nothing throws.
  engine.roll = 2;
  const { ctx, calls } = fakeCtx();
  engine.draw(ctx, 96, 136);
  assert.equal(calls.save, calls.restore);
  assert.ok(calls.fill > 4);
});

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = attrs.class ?? '';
    this.attrs = attrs;
    this.ownText = attrs.text ?? '';
    this.classList = {
      toggle: (name, on) => {
        const set = new Set(this.className.split(' ').filter(Boolean));
        if (on) set.add(name); else set.delete(name);
        this.className = [...set].join(' ');
      },
      contains: (name) => this.className.split(' ').includes(name),
    };
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on') && typeof value === 'function') this.addEventListener(key.slice(2), value);
    }
    this.children.push(...children.filter(Boolean));
  }
  get textContent() { return this.ownText + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(t) { this.ownText = t; this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  fire(name) { for (const fn of this.listeners[name] ?? []) fn({}); }
  getContext() { return null; }
  all() { return [this, ...this.children.filter((c) => c instanceof Element).flatMap((c) => c.all())]; }
}

test('the wardrobe shows every outfit, tries one on hover and keeps one on click', () => {
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: (el) => { el.children = []; },
    svg: () => new Element('svg'),
    dot: () => new Element('i'),
  };
  const stubs = {
    '/dom': dom,
    '/sound': { Sound: { play() {} } },
    '/minibots': { createMiniBot: () => new Element('canvas'), pruneMiniBots() {} },
    '/upload': { buildUpload: () => ({ el: new Element('div'), sync() {} }), buildUploading: () => ({ el: new Element('div'), sync() {} }), buildChoose: () => ({ el: new Element('div'), sync() {} }) },
    '/chat': { buildPrompt: () => ({ el: new Element('div'), sync() {} }) },
    '.css': {},
  };
  const cache = new Map();
  const extra = { globals: { document: { getElementById: () => new Element('main') }, requestAnimationFrame: (fn) => fn() } };
  const { State } = load(resolve(root, 'core/state.ts'), stubs, cache, extra);
  State.loadIntegrationTasks();
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const views = load(resolve(root, 'views/views.ts'), stubs, cache, extra);
  const wardrobe = views.buildViews(actions, () => {}).get('wardrobe');
  wardrobe.sync();
  const tiles = wardrobe.el.all().filter((el) => el.className.includes('outfit-tile'));
  assert.equal(tiles.length, 13);
  assert.equal(tiles[0].attrs.title, 'Auto (seasons)');
  assert.ok(tiles[0].className.includes('selected'), 'Auto is the default');
  const label = () => wardrobe.el.all().find((el) => el.className === 'wardrobe-label').textContent;
  assert.match(label(), /^Auto · /);

  const crown = tiles.find((t) => t.attrs.title === 'Crown');
  crown.fire('mouseenter');
  assert.deepEqual(calls.at(-1), ['previewOutfit', 'crown']);
  wardrobe.sync();
  assert.equal(label(), 'Crown');
  crown.fire('mouseleave');
  assert.deepEqual(calls.at(-1), ['previewOutfit', null]);
  crown.fire('click');
  assert.deepEqual(calls.at(-1), ['pickOutfit', 'crown']);
  State.settings.mochiOutfit = 'crown';
  wardrobe.sync();
  assert.ok(crown.className.includes('selected'));
  assert.equal(label(), 'Crown');
  // Hovering Auto tries on today's outfit and says what it is.
  tiles[0].fire('mouseenter');
  const season = load(resolve(root, 'mochi/outfits.ts'), stubs, cache, extra).seasonalOutfit(new Date());
  assert.deepEqual(calls.at(-1), ['previewOutfit', season]);
  wardrobe.sync();
  assert.match(label(), /^Auto · follows the seasons \(now: /);
  assert.equal(views.wardrobeLabel(null, 'auto', new Date(2026, 9, 7)), 'Auto · Witch hat');
  assert.equal(views.wardrobeLabel(null, 'auto', new Date(2026, 4, 7)), 'Auto · None');
});
