import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// The island views for the Codex pill, next to Claude Code's: the real view
// code with the DOM, native calls, sounds and canvases replaced.
class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = attrs.class ?? '';
    this.classList = { add() {}, remove() {}, contains: name => this.className.split(' ').includes(name), toggle() {} };
    this.value = attrs.value ?? '';
    this.disabled = attrs.disabled ?? false;
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
  async fire(name) {
    for (const callback of this.listeners[name] ?? []) await callback({ preventDefault() {}, stopPropagation() {} });
    await new Promise(setImmediate);
  }
  all() { return [this, ...this.children.filter(node => node instanceof Element).flatMap(node => node.all())]; }
  querySelector(selector) { return this.all().find(node => node.className.split(' ').includes(selector.slice(1))); }
  focus() {}
  scrollIntoView() {}
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const host = () => ({ el: new Element('div'), sync() {} });

function fixture() {
  const calls = [];
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: el => { el.children = []; el.ownText = ''; },
    svg: () => new Element('svg'),
    dot: () => new Element('i', { class: 'dot' }),
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(compiled, {
      exports, performance, console, setTimeout, clearTimeout,
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
        return load(resolve(dirname(file), name + '.ts'));
      },
    }, { filename: file });
    return exports;
  }
  const { Bridge } = load(resolve(root, 'core/bridge.ts'));
  Object.assign(Bridge, {
    openCodex: async () => { calls.push(['openCodex']); },
    openSettingsWindow: async section => { calls.push(['settings', section]); },
    refreshIntegration: async id => { calls.push(['refresh', id]); },
    codexHooksStatus: async () => ({ installed: true, anyInstalled: true, problem: null }),
    codexAppInstalled: async () => true,
  });
  const { State } = load(resolve(root, 'core/state.ts'));
  State.loadIntegrationTasks();
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const views = load(resolve(root, 'views/views.ts')).buildViews(actions, () => {});
  const view = name => { const v = views.get(name); v.sync(); return v.el; };
  const hostOf = name => views.get(name);
  const task = id => State.tasks.find(t => t.id === id);
  const button = (el, text) => el.all().find(node => node.tag === 'button' && node.textContent === text);
  return { State, view, host: hostOf, task, button, calls };
}

const hooksInfo = (configured, anyInstalled, app) => ({
  data: { anyInstalled, app }, error: null, loaded: false, configured,
});

test('idle Codex shows an integration card like Claude Code, with its hooks and app', async () => {
  const f = fixture();
  f.State.setFocus('agent_codex');
  f.State.integrations.agent_codex = hooksInfo(true, true, true);
  let card = f.view('overview');
  assert.match(card.textContent, /CodexIntegration/);
  assert.match(card.textContent, /Connected/);
  await f.button(card, 'Open Codex').fire('click');
  assert.deepEqual(f.calls.at(-1), ['openCodex']);
  assert.ok(f.button(card, 'Refresh'));
  assert.equal(f.button(card, 'Settings…'), undefined);

  f.State.integrations.agent_codex = hooksInfo(false, true, false);
  card = f.view('overview');
  assert.match(card.textContent, /Connected · repair hooks/);
  assert.equal(f.button(card, 'Open Codex'), undefined);
  await f.button(card, 'Settings…').fire('click');
  assert.deepEqual(f.calls.at(-1), ['settings', 'codex']);

  f.State.integrations.agent_codex = hooksInfo(false, false, false);
  assert.match(f.view('overview').textContent, /Hooks not installed/);

  // Claude Code's idle card is unchanged.
  f.State.setFocus('integration_claude');
  assert.match(f.view('overview').textContent, /Claude CodeIntegration/);
  assert.match(f.view('overview').textContent, /Open Visual Studio Code/);
});

test('a Codex session reads "Codex · Integration" in the ticker; the pill keeps its name', () => {
  const f = fixture();
  const codex = f.task('agent_codex');
  Object.assign(codex, { state: 'working', steps: ['fix it', 'Lit · README.md'], stepIndex: 1 });
  f.State.setFocus('agent_codex');
  const overview = f.view('overview');
  assert.match(overview.textContent, /CodexIntegration2\/2/);
  // The ticker, not the idle card.
  assert.doesNotMatch(overview.textContent, /Connected|Hooks|Open Codex/);
  // From Claude Code's side, the Codex pill still says Codex.
  f.State.setFocus('integration_claude');
  const pills = f.view('overview').all().filter(el => el.className === 'lbl').map(el => el.textContent);
  assert.ok(pills.includes('Codex'));
  assert.ok(!pills.includes('my-app'));
  // A settled turn keeps its steps on screen, as Claude Code's does.
  Object.assign(codex, { state: 'idle' });
  f.State.setFocus('agent_codex');
  assert.match(f.view('overview').textContent, /CodexIntegration/);
  assert.match(f.view('overview').textContent, /Lit · README\.md/);
  // Codex is light blue, like its Mochi.
  assert.equal(codex.color, '#7DD3FC');
});

test('finished, error, question and approval cards name Codex, not Claude Code', () => {
  const f = fixture();
  const codex = f.task('agent_codex');
  Object.assign(codex, { steps: ['All tests pass.'], stepIndex: 0 });
  f.State.setFocus('agent_codex');
  assert.match(f.view('finished').textContent, /Codexfinished/);
  assert.doesNotMatch(f.view('finished').textContent, /CodexCodex/);
  assert.match(f.view('error').textContent, /CodexIntegrationSession stopped on an error/);
  assert.doesNotMatch(f.view('error').textContent, /Claude Code/);
  assert.match(f.view('question').textContent, /Codex is asking a question/);
  assert.match(f.view('question').textContent, /Answer in Codex/);
  f.State.pendingApproval = { requestId: 'r', sessionId: 's', tool: 'Bash', command: 'Bash · npm install', pillId: 'agent_codex' };
  const approval = f.view('approval');
  assert.match(approval.textContent, /Codexneeds permission/);
  assert.match(approval.textContent, /Bash · npm install/);
  const labels = approval.all().filter(el => el.tag === 'button').map(el => el.textContent);
  assert.deepEqual(labels, ['DenyN', 'AllowY']);

  f.State.setFocus('integration_claude');
  assert.match(f.view('finished').textContent, /Claude Code finished/);
  assert.match(f.view('question').textContent, /Claude Code is asking a question/);
});

test('the island settings show the Codex hooks next to Claude Code', () => {
  const f = fixture();
  f.State.integrations.agent_codex = hooksInfo(true, true, true);
  assert.match(f.view('settings').textContent, /Claude CodeCodexAPI/);
});

test('switching pills shows each pill its own ticker lines', () => {
  const f = fixture();
  const claude = f.task('integration_claude');
  const codex = f.task('agent_codex');
  Object.assign(claude, { name: 'site', state: 'working', steps: ['p', 'Recherche', 'Modifie · a.ts'], stepIndex: 2 });
  Object.assign(codex, { state: 'working', steps: ['q', 'Lit · b.md', 'Exécute · npm test'], stepIndex: 2 });
  f.State.setFocus('integration_claude');
  assert.match(f.view('overview').textContent, /Modifie · a\.ts/);
  f.State.setFocus('agent_codex');
  const text = f.view('overview').textContent;
  assert.match(text, /Exécute · npm test/);
  assert.doesNotMatch(text, /Modifie · a\.ts/);
});

test('queued ticker steps keep the island animating until they have scrolled in', () => {
  const f = fixture();
  const codex = f.task('agent_codex');
  Object.assign(codex, { state: 'working', steps: ['q', 'Lit · a.md'], stepIndex: 1 });
  f.State.setFocus('agent_codex');
  f.view('overview');
  const overview = f.host('overview');
  assert.equal(overview.animating(), false);
  codex.steps.push('Exécute · npm test');
  codex.stepIndex = 2;
  overview.sync();
  assert.equal(overview.animating(), true);
  overview.tick(1000);
  overview.tick(1000 + 400);
  assert.equal(overview.animating(), false);
});
