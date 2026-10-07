import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// The Music pill (upstream #144, #153 with Windows' media controls instead of
// Apple Music): the pill, its hover controls, the card, and Mochi's dance.

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = attrs.class ?? '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: (n) => this.className.split(' ').includes(n) };
    this.attrs = attrs;
    this.ownText = attrs.text ?? '';
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on') && typeof value === 'function') this.addEventListener(key.slice(2), value);
    }
    this.append(...children);
  }
  append(...nodes) { this.children.push(...nodes.filter((n) => n != null && n !== false)); }
  get textContent() { return this.ownText + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(t) { this.ownText = t; this.children = []; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  fire(name) {
    const event = { stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} };
    for (const fn of this.listeners[name] ?? []) fn(event);
    return event;
  }
  querySelector(sel) { return this.all().find((n) => n.className.split(' ').includes(sel.slice(1))); }
  all() { return [this, ...this.children.filter((c) => c instanceof Element).flatMap((c) => c.all())]; }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function load(file, cache, ctx) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, ...ctx, require: (name) => ctx.resolve(name, file) }, { filename: file });
  return exports;
}

function fixture() {
  const cache = new Map();
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: (el) => { el.children = []; el.ownText = ''; },
    svg: () => new Element('svg'),
    dot: (color) => new Element('i', { class: 'dot', color }),
  };
  const host = () => ({ el: new Element('div'), sync() {} });
  const clock = { t: 1000 };
  const ctx = {
    console, Math, Date, setTimeout: () => 0, clearTimeout() {},
    performance: { now: () => clock.t },
    window: { setTimeout: () => 0, clearTimeout() {}, devicePixelRatio: 1 },
    document: { getElementById: () => new Element('main'), createElement: (t) => new Element(t) },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
    Path2D: class { moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} addPath() {} },
    resolve(name, from) {
      if (name.startsWith('@tauri-apps/')) return {};
      if (name.endsWith('.css')) return {};
      if (name.endsWith('/dom')) return dom;
      if (name.endsWith('/sound')) return { Sound: { play() {} } };
      if (name.endsWith('/minibots')) return { createMiniBot: () => new Element('span'), pruneMiniBots() {} };
      if (name.endsWith('/upload')) return { buildUpload: host, buildUploading: host, buildChoose: host };
      if (name.endsWith('/chat')) return { buildPrompt: host };
      return load(resolve(dirname(from), `${name}.ts`), cache, ctx);
    },
  };
  const calls = [];
  const { Bridge } = load(resolve(root, 'core/bridge.ts'), cache, ctx);
  Bridge.musicControl = async (action) => { calls.push(['music', action]); };
  Bridge.usageRefresh = async () => {};
  const { State } = load(resolve(root, 'core/state.ts'), cache, ctx);
  State.settings.activeIntegrations = ['integration_music', 'integration_github'];
  State.loadIntegrationTasks();
  State.integrations.integration_music = { data: {}, error: null, loaded: true, configured: true };
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const views = load(resolve(root, 'views/views.ts'), cache, ctx);
  const overview = views.buildViews(actions, () => {}).get('overview');
  Object.assign(State, { view: 'overview', mode: 'expanded' });
  return { State, overview, calls, cache, ctx, clock };
}

const SONG = { title: 'Harder, Better', artist: 'Daft Punk', album: 'Discovery', playing: true };

test('the Music pill is a pill like the others, off until chosen', () => {
  const f = fixture();
  const { TOGGLEABLE_INTEGRATION_IDS, INTEGRATION_AGENTS } = load(resolve(root, 'core/state.ts'), f.cache, f.ctx);
  assert.ok(TOGGLEABLE_INTEGRATION_IDS.includes('integration_music'));
  const music = INTEGRATION_AGENTS.find((t) => t.id === 'integration_music');
  assert.equal(music.name, 'Music');
  assert.equal(music.color, '#FA2D48');
  assert.ok(!load(resolve(root, 'core/state.ts'), f.cache, f.ctx).DEFAULT_SETTINGS.activeIntegrations.includes('integration_music'));
});

test('the pill names the track, and play/pause and next work without taking the focus', () => {
  const f = fixture();
  f.State.setFocus('integration_claude');
  f.overview.sync();
  const pill = () => f.overview.el.all().find((el) => el.className.includes('pill') && el.className.includes('music'));
  assert.equal(pill(), undefined, 'no controls while nothing plays');
  const plain = f.overview.el.all().find((el) => el.className === 'pill' && el.textContent === 'Music');
  assert.ok(plain, 'the pill says Music');

  f.State.music = SONG;
  f.overview.sync();
  assert.equal(pill().querySelector('.lbl').textContent, 'Harder, Better');
  const buttons = pill().all().filter((el) => el.className === 'pill-music-btn');
  assert.deepEqual(buttons.map((b) => b.attrs.title), ['Pause', 'Next']);
  const event = buttons[0].fire('click');
  assert.ok(event.stopped, 'the click stays on the button');
  assert.deepEqual(f.calls.at(-1), ['music', 'toggle']);
  buttons[1].fire('click');
  assert.deepEqual(f.calls.at(-1), ['music', 'next']);
  assert.ok(!f.calls.some((c) => c[0] === 'setFocus'));
  // Paused: the button offers Play.
  f.State.music = { ...SONG, playing: false };
  f.overview.sync();
  assert.equal(pill().all().find((el) => el.className === 'pill-music-btn').attrs.title, 'Play');
});

test('the Music card shows the track and its controls, or says nothing plays', () => {
  const f = fixture();
  f.State.setFocus('integration_music');
  f.overview.sync();
  assert.match(f.overview.el.textContent, /MusicIntegrationNot playing/);
  f.State.music = SONG;
  f.overview.sync();
  assert.match(f.overview.el.textContent, /Harder, BetterDaft Punk/);
  const controls = f.overview.el.all().filter((el) => el.className.startsWith('music-btn'));
  assert.deepEqual(controls.map((c) => c.attrs.title), ['Previous', 'Pause', 'Next']);
  controls[0].fire('click');
  assert.deepEqual(f.calls.at(-1), ['music', 'previous']);
  // Without media controls (Linux for now) it says so.
  f.State.music = null;
  f.State.integrations.integration_music = { data: {}, error: null, loaded: true, configured: false };
  f.overview.sync();
  assert.match(f.overview.el.textContent, /Not available on this system yet/);
});

test('Mochi dances in on 0.3 s and out over 0.5 s, and keeps drawing', () => {
  const f = fixture();
  const { BotEngine } = load(resolve(root, 'mochi/engine.ts'), f.cache, f.ctx);
  const engine = new BotEngine();
  const step = (ms) => { f.clock.t += ms; engine.update(ms / 1000); };
  engine.setDancing(true);
  step(150);
  assert.ok(Math.abs(engine.dancingLevel - 0.5) < 0.01);
  step(200);
  assert.equal(engine.dancingLevel, 1);
  assert.ok(engine.busy, 'a dancing Mochi keeps the frame loop going');
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : p.startsWith?.('create') ? () => grad : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
  engine.draw(ctx, 96, 136);
  engine.setDancing(false);
  step(250);
  assert.ok(Math.abs(engine.dancingLevel - 0.5) < 0.01);
  step(300);
  assert.equal(engine.dancingLevel, 0);
});
