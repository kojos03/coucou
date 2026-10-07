import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// The weekly recap (upstream #264): the history, the summary of last week, the
// Monday card, the island card and the share image.

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = attrs.class ?? '';
    this.classList = {
      add: (n) => { this.className = `${this.className} ${n}`.trim(); },
      remove() {}, toggle() {}, contains: (n) => this.className.split(' ').includes(n),
    };
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
  fire(name) { for (const fn of this.listeners[name] ?? []) fn({ stopPropagation() {}, preventDefault() {} }); }
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
  const saved = [];
  const timers = [];
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: (el) => { el.children = []; el.ownText = ''; },
    svg: () => new Element('svg'),
    dot: (color) => new Element('i', { class: 'dot', color }),
  };
  const host = () => ({ el: new Element('div'), sync() {} });
  const ctx = {
    console, Math, Date, JSON, setTimeout: () => 0, clearTimeout() {},
    performance: { now: () => 1000 },
    window: { setTimeout: (fn) => timers.push(fn), clearTimeout() {}, devicePixelRatio: 1 },
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
  const { Bridge } = load(resolve(root, 'core/bridge.ts'), cache, ctx);
  Bridge.recapSave = async (text) => { saved.push(text); };
  Bridge.log = async () => {};
  Bridge.usageRefresh = async () => {};
  const recap = load(resolve(root, 'core/recap.ts'), cache, ctx);
  const { State } = load(resolve(root, 'core/state.ts'), cache, ctx);
  return { cache, ctx, recap, State, saved, timers };
}

/** A store on a hand-moved clock. */
function store(recap, start = new Date(2026, 9, 1, 9, 0)) {
  const clock = { t: start.getTime() };
  const saved = [];
  const settings = { on: true };
  const s = new recap.RecapStore({ enabled: () => settings.on, persist: (t) => saved.push(t), now: () => clock.t });
  const at = (y, m, d, h, min = 0) => { clock.t = new Date(y, m, d, h, min).getTime(); };
  const later = (minutes) => { clock.t += minutes * 60_000; };
  return { s, clock, saved, settings, at, later };
}

test('weeks run Monday to Sunday, numbered as ISO 8601 numbers them', () => {
  const { recap } = fixture();
  assert.equal(recap.isoWeekKey(new Date(2026, 9, 5)), 202641);
  assert.equal(recap.isoWeekKey(new Date(2026, 9, 4)), 202640);
  assert.equal(recap.isoWeekKey(new Date(2021, 0, 3)), 202053);
  assert.equal(recap.isoWeekKey(new Date(2024, 11, 30)), 202501);
  const monday = recap.mondayOf(new Date(2026, 9, 4, 23, 30));
  assert.deepEqual([monday.getFullYear(), monday.getMonth(), monday.getDate(), monday.getHours()], [2026, 8, 28, 0]);
  assert.equal(recap.mondayOf(new Date(2026, 9, 5, 0, 1)).getDate(), 5);
  assert.equal(recap.formatDuration(5), '5m');
  assert.equal(recap.formatDuration(120), '2h');
  assert.equal(recap.formatDuration(125), '2h 5m');
});

test('a week of turns sums up like macOS: parallel turns count once, tops and busiest day', () => {
  const { recap } = fixture();
  const { s, at, later, saved } = store(recap);
  // Tuesday 29 Sep: Claude Code on coucou, 30 min, with a parallel Codex turn.
  at(2026, 8, 29, 10);
  s.userPromptSubmit('c1', 'integration_claude', 'coucou');
  later(5);
  s.userPromptSubmit('x1', 'agent_codex', 'site');
  s.preToolUse('c1', 'Bash');
  s.preToolUse('c1', 'Read');
  s.preToolUse('x1', 'PowerShell');
  s.recordFileDiff('c1', 'C:/p/a.ts', 10, 2);
  s.recordFileDiff('c1', 'C:/p/a.ts', 3, 1);
  s.recordFileDiff('c1', 'C:/p/b.ts', 1, 0);
  later(10);
  s.stop('x1');
  later(15);
  s.stop('c1');
  // Thursday 1 Oct: two more Claude Code turns on coucou, 45 min apart.
  at(2026, 9, 1, 14);
  s.userPromptSubmit('c2', 'integration_claude', 'coucou');
  later(20);
  s.stop('c2');
  at(2026, 9, 1, 15);
  s.userPromptSubmit('c3', 'integration_claude', 'coucou');
  later(25);
  s.stop('c3');
  s.recordDecision('integration_claude', 'allow');
  s.recordDecision('agent_codex', 'always');
  s.recordDecision('integration_claude', 'deny');
  assert.ok(saved.length >= 5, 'saved after each turn and decision');

  at(2026, 9, 5, 9); // the next Monday
  const w = s.weeklySummary();
  assert.equal(w.weekStart.getDate(), 28);
  assert.deepEqual([w.weekEnd.getDate(), w.weekEnd.getHours(), w.weekEnd.getMinutes()], [4, 23, 59]);
  assert.equal(w.sessionCount, 4);
  assert.equal(w.totalMinutes, 30 + 20 + 25, 'the Codex turn ran inside the Claude Code one');
  assert.equal(w.filesChanged, 2);
  assert.equal(w.linesAdded, 14);
  assert.equal(w.linesRemoved, 3);
  assert.equal(w.commandsRun, 2);
  assert.equal(w.permissionsAllowed, 2);
  assert.equal(w.permissionsDenied, 1);
  assert.equal(w.topAgent, 'Claude Code');
  assert.equal(w.topProject, 'coucou');
  assert.equal(w.busiestDay, 'Tuesday', 'two turns each: the first day seen wins the tie');
  assert.equal(w.longestSessionMinutes, 30);
  assert.equal(recap.weekRangeLabel(w), 'Sep 28 – Oct 4');
  // This week has nothing yet; the week before that has nothing either.
  assert.equal(s.weeklySummary(new Date(2026, 9, 5)), null);
  assert.equal(s.weeklySummary(new Date(2026, 8, 21)), null);
});

test('a silent turn closes after two hours, history keeps 12 weeks, and off means off', () => {
  const { recap } = fixture();
  const { s, at, later, settings } = store(recap);
  at(2026, 8, 29, 10);
  s.userPromptSubmit('lost', 'agent_copilot', 'app');
  s.preToolUse('lost', 'bash');
  later(10);
  s.preToolUse('lost', 'bash');
  later(150);
  s.userPromptSubmit('next', 'integration_claude', 'app'); // closes the silent one
  at(2026, 9, 5, 9);
  const w = s.weeklySummary();
  assert.equal(w.sessionCount, 1);
  assert.equal(w.totalMinutes, 10, 'it ends at its last event');
  assert.equal(w.commandsRun, 2);
  assert.equal(w.topAgent, 'Copilot CLI');

  // Thirteen weeks on, a new turn prunes the old ones.
  at(2026, 11, 29, 10);
  s.userPromptSubmit('late', 'integration_claude', 'app');
  later(1);
  s.stop('late');
  assert.equal(s.weeklySummary(new Date(2026, 8, 28)), null);

  // Turned off: nothing is recorded.
  settings.on = false;
  at(2027, 0, 5, 10);
  s.userPromptSubmit('off', 'integration_claude', 'app');
  later(5);
  s.stop('off');
  s.recordDecision('integration_claude', 'allow');
  at(2027, 0, 11, 9);
  assert.equal(s.weeklySummary(), null);
});

test('the saved history loads back, minus anything malformed', () => {
  const { recap } = fixture();
  const { s, at, later, saved } = store(recap);
  at(2026, 8, 30, 11);
  s.userPromptSubmit('a', 'integration_claude', 'p');
  later(12);
  s.stop('a');
  const text = saved.at(-1);
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  parsed.turns.push({ pillId: 3, start: 'x' }, null);
  const again = store(recap, new Date(2026, 9, 5, 9));
  again.s.load(JSON.stringify(parsed));
  assert.equal(again.s.weeklySummary().sessionCount, 1);
  again.s.load('{ not json');
  assert.equal(again.s.weeklySummary(), null);
  again.s.load(null);
  assert.equal(again.s.weeklySummary(), null);
});

test('the Monday card: from 8 am, once a week, with something to show and nothing waiting', () => {
  const { recap } = fixture();
  const { s, at, later } = store(recap);
  at(2026, 8, 29, 10);
  s.userPromptSubmit('a', 'integration_claude', 'p');
  later(30);
  s.stop('a');
  const due = (date, pending = false) => { at(...date); return recap.mondayRecapDue(new Date(s['opts'].now()), s, pending); };
  assert.equal(due([2026, 9, 5, 7, 59]), null, 'too early');
  assert.equal(due([2026, 9, 6, 9]), null, 'not Monday');
  assert.equal(due([2026, 9, 5, 8], true), null, 'an approval is waiting');
  assert.equal(due([2026, 9, 5, 8]), 202641);
  s.markShown(202641);
  assert.equal(due([2026, 9, 5, 11]), null, 'once a week');
  assert.equal(due([2026, 9, 12, 9]), null, 'the next week had nothing');
});

test('hook events feed the history: prompt, commands, edited lines, the Stop', () => {
  const f = fixture();
  const listeners = {};
  // The hook listener with the real AppState and recap; native calls stubbed.
  const ctx = { ...f.ctx };
  const bridge = load(resolve(root, 'core/bridge.ts'), f.cache, ctx);
  bridge.onEvent = (event, fn) => { listeners[event] = fn; };
  const island = { alert() {}, setView() {}, reveal() {}, dropPin() {} };
  const hooks = load(resolve(root, 'island/hooks.ts'), f.cache, f.ctx);
  // onEvent is imported by name, so register through the module's own export.
  hooks.registerHookHandlers(island);
  const send = listeners.hook ?? (() => { throw new Error('no hook listener'); });
  send({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: 'C:/work/site', prompt: 'p' });
  send({ hook_event_name: 'PreToolUse', session_id: 's', cwd: 'C:/work/site', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  send({ hook_event_name: 'PostToolUse', session_id: 's', cwd: 'C:/work/site', tool_name: 'Edit',
    tool_input: { file_path: 'C:/work/site/a.ts' }, coucou_diff: { path: 'C:/work/site/a.ts', added: 4, removed: 1 } });
  send({ coucou_agent: 'copilot', hook_event_name: 'UserPromptSubmit', session_id: 'k', cwd: 'C:/work/app', prompt: 'q' });
  send({ hook_event_name: 'Stop', session_id: 's', cwd: 'C:/work/site' });
  send({ coucou_agent: 'copilot', hook_event_name: 'Stop', session_id: 'k', cwd: 'C:/work/app' });
  const w = f.recap.Recap.weeklySummary(f.recap.mondayOf(new Date()));
  assert.equal(w.sessionCount, 2);
  assert.equal(w.commandsRun, 1);
  assert.equal(w.filesChanged, 1);
  assert.equal(w.linesAdded, 4);
  assert.equal(w.linesRemoved, 1);
  assert.ok(f.saved.length >= 2, 'saved through the bridge');
  assert.deepEqual(JSON.parse(f.saved.at(-1)).turns.map((t) => [t.pillId, t.project]),
    [['integration_claude', 'site'], ['agent_copilot', 'app']]);
});

test('the island card shows last week, or says there was nothing', () => {
  const f = fixture();
  const views = load(resolve(root, 'views/views.ts'), f.cache, f.ctx);
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const card = views.buildViews(actions, () => {}).get('recap');
  card.sync();
  assert.match(card.el.textContent, /No activity last week/);
  card.el.all().find((el) => el.textContent === 'OK' && el.tag === 'button').fire('click');
  assert.deepEqual(calls.at(-1), ['collapse']);

  const monday = f.recap.mondayOf(new Date());
  const start = f.recap.addDays(monday, -6).getTime() + 10 * 3600_000; // last Tuesday, 10:00
  f.recap.Recap.load(JSON.stringify({ schemaVersion: 1, decisions: [], turns: [
    { pillId: 'integration_claude', project: 'site', start, end: start + 95 * 60_000,
      filesChanged: 3, linesAdded: 120, linesRemoved: 7, commandsRun: 5, questions: 0 },
  ] }));
  card.sync();
  const text = card.el.textContent;
  assert.match(text, /^Weekly recap[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+/);
  assert.match(text, /1h 35mcoding1session3files5commands\+120 \/ -7lines/);
  assert.match(text, /Share imageOK/);
  assert.deepEqual(views.recapChips({ ...f.recap.Recap.weeklySummary(), filesChanged: 1, commandsRun: 0, linesAdded: 0, linesRemoved: 0, questionsAnswered: 1 })
    .map((c) => c[1]).join(), 'coding,session,file,question');
});

test('the share image says what the macOS one says, and can leave projects out', () => {
  const f = fixture();
  const img = load(resolve(root, 'views/recap-image.ts'), f.cache, f.ctx);
  const texts = [];
  const ctx2d = new Proxy({ measureText: (s) => ({ width: s.length * 10 }) }, {
    get: (t, p) => (p in t ? t[p] : p === 'fillText' ? (s) => texts.push(s)
      : p.startsWith?.('create') ? () => ({ addColorStop() {} }) : () => {}),
    set: (t, p, v) => { t[p] = v; return true; },
  });
  const summary = {
    weekStart: new Date(2026, 8, 28), weekEnd: new Date(2026, 9, 4, 23, 59, 59),
    totalMinutes: 545, sessionCount: 12, filesChanged: 30, linesAdded: 900, linesRemoved: 120,
    commandsRun: 44, questionsAnswered: 0, permissionsAllowed: 6, permissionsDenied: 1,
    topAgent: 'Claude Code', topProject: 'coucou', busiestDay: 'Thursday', longestSessionMinutes: 80,
  };
  let mochi = 0;
  img.drawRecapImage(ctx2d, summary, false, () => { mochi += 1; });
  assert.equal(mochi, 1);
  assert.deepEqual(texts, [
    'Coucou', 'Weekly recap', 'Sep 28 – Oct 4', '9h 5m', 'TIME CODING',
    '12', 'SESSIONS', '30', 'FILES', '44', 'COMMANDS', '+900', '−120',
    'Top agent', 'Claude Code', 'Top project', 'coucou', 'Busiest day', 'Thursday',
    'Longest session', '1h 20m', 'Approved', '6', 'Denied', '1',
    'Coucou · github.com/Louis-CFM/coucou',
  ]);
  texts.length = 0;
  img.drawRecapImage(ctx2d, { ...summary, commandsRun: 0, linesAdded: 0, linesRemoved: 0, permissionsAllowed: 0, permissionsDenied: 0 }, true, () => {});
  assert.ok(!texts.includes('Top project') && !texts.includes('coucou'), 'projects hidden');
  assert.ok(!texts.includes('COMMANDS') && !texts.includes('Approved'));
});
