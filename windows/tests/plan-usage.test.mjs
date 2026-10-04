import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// The Claude plan pill and card (upstream #159): the gauge maths, and the real
// header and overview views with the DOM and native calls replaced.
class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = attrs.class ?? '';
    this.classList = { add() {}, remove() {}, contains: name => this.className.split(' ').includes(name), toggle() {} };
    this.hidden = attrs.hidden ?? false;
    this.attrs = attrs;
    this.ownText = attrs.text ?? '';
    this.append(...children);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on') && typeof value === 'function') this.addEventListener(key.slice(2), value);
    }
  }
  append(...nodes) { this.children.push(...nodes.filter(node => node != null && node !== false)); }
  get textContent() { return this.ownText + this.children.map(node => typeof node === 'string' ? node : node.textContent).join(''); }
  set textContent(text) { this.ownText = text; this.children = []; }
  addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
  fire(name) { for (const callback of this.listeners[name] ?? []) callback({ preventDefault() {}, stopPropagation() {} }); }
  all() { return [this, ...this.children.filter(node => node instanceof Element).flatMap(node => node.all())]; }
  querySelector(selector) { return this.all().find(node => node.className.split(' ').includes(selector.slice(1))); }
  focus() {}
  scrollIntoView() {}
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function load(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: el => { el.children = []; el.ownText = ''; },
    svg: () => new Element('svg'),
    dot: color => new Element('i', { class: 'dot', color }),
  };
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, performance, console, setTimeout, clearTimeout, Date,
    window: { setTimeout, clearTimeout },
    document: { getElementById: () => new Element('main') },
    requestAnimationFrame: fn => fn(),
    require: name => {
      if (name.endsWith('.css')) return {};
      if (name.startsWith('@tauri-apps/')) return {};
      if (name.endsWith('/dom')) return dom;
      if (name.endsWith('/sound')) return { Sound: { play() {} } };
      if (name.endsWith('/minibots')) return { createMiniBot: () => new Element('canvas'), pruneMiniBots() {} };
      if (name.endsWith('/upload')) return { buildUpload: host, buildUploading: host, buildChoose: host };
      return load(resolve(dirname(file), name + '.ts'), cache);
    },
  }, { filename: file });
  return exports;
}
const host = () => ({ el: new Element('div'), sync() {} });

const NOW = Date.now() / 1000;
const usage = (five, week, updatedAt = NOW - 30) => ({
  fiveHour: five == null ? null : { usedPct: five, resetsAt: NOW + 4830 },
  sevenDay: week == null ? null : { usedPct: week, resetsAt: NOW + 3 * 86400 },
  updatedAt,
});

test('the gauge picks the fuller window, colours it and labels it like macOS', () => {
  const plan = load(resolve(root, 'core/plan.ts'));
  assert.equal(plan.dominantPct(usage(23.5, 41), NOW), 41);
  assert.equal(plan.dominantPct(usage(null, null), NOW), null);
  assert.equal(plan.dominantPct(null, NOW), null);
  // A window whose reset has passed counts as empty.
  assert.equal(plan.effectivePct({ usedPct: 90, resetsAt: NOW - 1 }, NOW), 0);
  assert.deepEqual([null, 0, 49.9, 50, 79.9, 80, 100].map(plan.planColor),
    ['#6B7079', '#22C55E', '#22C55E', '#F59E0B', '#F59E0B', '#F4505E', '#F4505E']);
  assert.equal(plan.pillLabel(usage(72.6, 10), NOW), 'Claude 73%');
  assert.equal(plan.pillLabel(null, NOW), 'Claude —');
  assert.equal(plan.resetLabel({ usedPct: 1, resetsAt: NOW + 4800 }, false, NOW), 'in 1 h 20');
  assert.equal(plan.resetLabel({ usedPct: 1, resetsAt: NOW + 720 }, false, NOW), 'in 12 min');
  assert.equal(plan.resetLabel({ usedPct: 1, resetsAt: NOW - 5 }, true, NOW), 'Resetting…');
  // Monday 5 October 2026, 9:00 local time.
  const monday = new Date(2026, 9, 5, 9, 0).getTime() / 1000;
  assert.equal(plan.resetLabel({ usedPct: 1, resetsAt: monday }, true, monday - 86400), 'Mon 9:00');
  assert.equal(plan.ageLabel(null, NOW), 'Waiting for a Claude Code reply');
  assert.equal(plan.ageLabel(usage(1, 1, NOW - 10), NOW), 'just now');
  assert.equal(plan.ageLabel(usage(1, 1, NOW - 600), NOW), '10 min ago');
  assert.equal(plan.ageLabel(usage(1, 1, NOW - 7300), NOW), '2 h ago');
});

function islandFixture() {
  const cache = new Map();
  const calls = [];
  const { State } = load(resolve(root, 'core/state.ts'), cache);
  State.loadIntegrationTasks();
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const views = load(resolve(root, 'views/views.ts'), cache);
  const header = views.buildHeader(actions);
  const overview = views.buildViews(actions, () => {}).get('overview');
  const sync = () => { header.sync(); overview.sync(); };
  const pill = () => header.el.all().find(el => el.className === 'plan-pill');
  return { State, header, overview, sync, pill, calls };
}

test('the header pill shows only on the home view, with the setting and the relay', () => {
  const f = islandFixture();
  f.State.view = 'overview';
  f.sync();
  assert.equal(f.pill().hidden, true);
  f.State.settings.showPlanUsage = true;
  f.sync();
  assert.equal(f.pill().hidden, true, 'no relay, no pill');
  f.State.planRelayInstalled = true;
  f.sync();
  assert.equal(f.pill().hidden, false);
  assert.equal(f.pill().textContent, 'Claude —');
  f.State.planUsage = usage(23, 85);
  f.sync();
  assert.equal(f.pill().textContent, 'Claude 85%');
  assert.equal(f.pill().all().find(el => el.tag === 'i').style.background, '#F4505E');
  f.State.view = 'settings';
  f.sync();
  assert.equal(f.pill().hidden, true);
});

test('the pill opens the plan card in place of the left card, and focus closes it', () => {
  const f = islandFixture();
  Object.assign(f.State, { view: 'overview', planRelayInstalled: true, planUsage: usage(23.5, 41) });
  f.State.settings.showPlanUsage = true;
  f.State.setFocus('integration_claude');
  f.sync();
  assert.match(f.overview.el.textContent, /Claude CodeIntegration/);
  f.pill().fire('click');
  assert.equal(f.State.showingPlanDetail, true);
  f.sync();
  const text = f.overview.el.textContent;
  assert.match(text, /Claude planjust now/);
  assert.match(text, /5 hours24%in 1 h 20/);
  assert.match(text, /Week41%/);
  assert.equal(f.overview.el.all().find(el => el.className.includes('jump')).style.display, 'none');
  // No numbers yet: dashes, and the card says what it waits for.
  f.State.planUsage = null;
  f.sync();
  assert.match(f.overview.el.textContent, /Waiting for a Claude Code reply5 hours—Week—/);
  // Picking a pill closes it, as on macOS.
  f.State.setFocus('agent_codex');
  f.sync();
  assert.equal(f.State.showingPlanDetail, false);
  assert.doesNotMatch(f.overview.el.textContent, /Claude plan/);
  // Removing the status line takes the open card down with the pill.
  f.pill().fire('click');
  f.sync();
  assert.match(f.overview.el.textContent, /Claude plan/);
  f.State.planRelayInstalled = false;
  f.sync();
  assert.equal(f.State.showingPlanDetail, false);
  assert.doesNotMatch(f.overview.el.textContent, /Claude plan/);
});
