import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real view handlers with native calls and DOM I/O replaced.
// Native credential and process behavior is covered by the Rust tests.
class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = attrs.class ?? '';
    this.classList = { add() {}, contains: name => this.className.split(' ').includes(name), toggle() {} };
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
    if (this.disabled) return;
    for (const callback of this.listeners[name] ?? []) await callback({ preventDefault() {}, stopPropagation() {} });
    await new Promise(setImmediate);
  }
  all() { return [this, ...this.children.filter(node => node instanceof Element).flatMap(node => node.all())]; }
  querySelector(selector) { return this.all().find(node => node.className.split(' ').includes(selector.slice(1))); }
  focus() { this.focused = true; }
  select() {}
  scrollIntoView() { this.scrolled = true; }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
async function fixture(overrides = {}, settings = false) {
  const page = new Element('main');
  const events = new Map(), cache = new Map();
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: el => { el.children = []; el.ownText = ''; },
    svg: () => new Element('svg'),
  };
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
      document: { getElementById: () => page },
      requestAnimationFrame: fn => fn(),
      require: name => {
        if (name.endsWith('.css')) return {};
        if (name.startsWith('@tauri-apps/')) return {};
        if (name.endsWith('/dom')) return dom;
        if (name.endsWith('/sound')) return { Sound: { play() {} } };
        return load(resolve(dirname(file), name + '.ts'));
      },
    }, { filename: file });
    return exports;
  }
  const bridge = load(resolve(root, 'core/bridge.ts'));
  Object.assign(bridge.Bridge, {
    boot: async () => null,
    hooksStatus: async () => ({ installed: false, settingsPath: '', hookPath: '', hookReady: false }),
    secretPresent: async () => false,
    saveSettings: async () => {},
    ...overrides,
  });
  bridge.onEvent = async (name, callback) => { events.set(name, callback); };
  const { State } = load(resolve(root, 'core/state.ts'));
  let view;
  if (settings) {
    load(resolve(root, 'settings/main.ts'));
    await new Promise(setImmediate);
  } else {
    view = load(resolve(root, 'views/chat.ts')).buildPrompt(() => {});
    State.subscribe(() => view.sync());
    page.append(view.el);
    view.sync();
  }
  const api = () => page.all().find(el => el.attrs.id === 'claude-api');
  const button = (text, container = page) => container.all().find(el => el.tag === 'button' && el.textContent === text);
  return { page, State, Bridge: bridge.Bridge, events, view, api, button };
}

test('missing chat key preserves the question and attachment through setup and retry', async () => {
  const calls = [], settings = [];
  const f = await fixture({
    chatSend: async (...args) => { calls.push(args); throw { code: 'missing_key', message: 'Add an Anthropic key.', settings: true }; },
    openSettingsWindow: section => { settings.push(section); },
  });
  f.State.view = 'prompt';
  f.State.droppedFile = { name: 'sample.txt', path: 'C:/sample.txt' };
  const input = f.page.all().find(el => el.tag === 'input');
  input.value = 'Explain this file';
  await f.page.all().find(el => el.className === 'send-btn').fire('click');
  assert.equal(f.State.view, 'prompt');
  assert.equal(input.value, 'Explain this file');
  assert.equal(f.State.chatHistory.length, 0);
  assert.match(f.page.textContent, /Add an Anthropic key/);
  await f.button('Chat settings').fire('click');
  assert.deepEqual(settings, ['claude']);
  f.Bridge.chatSend = async (...args) => { calls.push(args); return { text: 'Done' }; };
  await f.button('Retry').fire('click');
  assert.equal(f.State.chatHistory.length, 2);
  assert.equal(f.State.chatHistory[1].content, 'Done');
  assert.deepEqual(calls.map(call => call[0]), ['anthropic', 'anthropic']);
  assert.equal(calls[0][2].path, 'C:/sample.txt');
  assert.equal(calls[1][2].path, 'C:/sample.txt');
  assert.equal(f.page.all().find(el => el.className === 'chat-error').hidden, true);
});

test('transient chat error offers retry without misleading key setup', async () => {
  const f = await fixture({ chatSend: async () => { throw { code: 'network', message: 'Check your connection.', settings: false }; } });
  f.page.all().find(el => el.tag === 'input').value = 'Hello';
  await f.page.all().find(el => el.className === 'send-btn').fire('click');
  assert.match(f.page.textContent, /Check your connection/);
  assert.equal(f.button('Chat settings'), undefined);
  assert.ok(f.button('Retry'));
});

test('duplicate sends are blocked while a chat request is pending', async () => {
  let resolveReply, calls = 0;
  const f = await fixture({ chatSend: () => { calls++; return new Promise(resolve => { resolveReply = resolve; }); } });
  const input = f.page.all().find(el => el.tag === 'input');
  const send = f.page.all().find(el => el.className === 'send-btn');
  input.value = 'Hello';
  await send.fire('click');
  input.value = 'Another question';
  await send.fire('click');
  assert.equal(calls, 1);
  assert.equal(input.disabled, true);
  resolveReply({ text: 'Reply' });
  await new Promise(setImmediate);
  assert.equal(input.disabled, false);
});

test('credential read failures are visible and do not claim the key is missing', async () => {
  const f = await fixture({ secretPresent: async key => {
    if (key === 'anthropic-api-key') throw 'Could not read the credential store.';
    return false;
  } }, true);
  assert.match(f.api().textContent, /Could not read the credential store/);
  assert.doesNotMatch(f.api().textContent, /Add an Anthropic API key to use/);
  assert.equal(f.button('Test connection').disabled, true);
  f.events.get('settings-section')('claude');
  assert.equal(f.api().scrolled, true);
});

test('save and remove update presence without rendering the key', async () => {
  let stored = false, saved = '';
  const f = await fixture({
    secretPresent: async key => key === 'anthropic-api-key' && stored,
    secretSet: async (_, value) => { saved = value; stored = true; },
    secretClear: async () => { stored = false; },
  }, true);
  const field = f.api().all().find(el => el.tag === 'input');
  field.value = 'non-secret-test-value';
  await f.button('Save key').fire('click');
  assert.equal(saved, 'non-secret-test-value');
  assert.equal(field.value, '');
  assert.doesNotMatch(f.api().textContent, /non-secret-test-value/);
  assert.equal(f.button('Test connection').disabled, false);
  await f.button('Remove').fire('click');
  assert.equal(f.button('Test connection').disabled, true);
  assert.match(f.api().textContent, /Key removed/);
});

test('failed credential writes are reported and clear the password field', async () => {
  const f = await fixture({ secretSet: async () => { throw 'Credential store unavailable.'; } }, true);
  const field = f.api().all().find(el => el.tag === 'input');
  field.value = 'non-secret-test-value';
  await f.button('Save key').fire('click');
  assert.match(f.api().textContent, /Credential store unavailable/);
  assert.equal(field.value, '');
  assert.doesNotMatch(f.api().textContent, /Key saved securely/);
});

test('connection test uses the selected model and requires unsaved keys to be saved first', async () => {
  const models = [];
  const f = await fixture({
    secretPresent: async key => key === 'anthropic-api-key',
    chatTestConnection: async (provider, model) => { models.push([provider, model]); },
  }, true);
  f.api().all().find(el => el.tag === 'select').value = 'claude-sonnet-5';
  const field = f.api().all().find(el => el.tag === 'input');
  field.value = 'new-unsaved-value';
  await f.button('Test connection').fire('click');
  assert.equal(models.length, 0);
  assert.match(f.api().textContent, /Save the new key before testing/);
  field.value = '';
  await f.button('Test connection').fire('click');
  assert.deepEqual(models, [['anthropic', 'claude-sonnet-5']]);
  assert.match(f.api().textContent, /No chat message was sent/);
});

// ── Two Mochis: Codex's chats through OpenAI, the others through Anthropic ─────

const chatControls = f => ({
  input: f.page.all().find(el => el.tag === 'input'),
  send: f.page.all().find(el => el.className === 'send-btn'),
  error: f.page.all().find(el => el.className === 'chat-error'),
});

test('Codex and Claude Mochis keep separate conversations and providers', async () => {
  const calls = [];
  const f = await fixture({ chatSend: async (provider, query) => { calls.push([provider, query]); return { text: `${provider} reply` }; } });
  f.State.loadIntegrationTasks();
  const { input, send } = chatControls(f);
  f.State.setFocus('integration_claude');
  assert.doesNotMatch(input.placeholder, /OpenAI/);
  input.value = 'Hello Claude';
  await send.fire('click');
  f.State.setFocus('agent_codex');
  assert.doesNotMatch(f.page.textContent, /Hello Claude/);
  assert.match(input.placeholder, /OpenAI/);
  input.value = 'Hello Codex';
  await send.fire('click');
  assert.deepEqual(calls, [['anthropic', 'Hello Claude'], ['openai', 'Hello Codex']]);
  assert.deepEqual(Array.from(f.State.chatHistories.openai, m => m.content), ['Hello Codex', 'openai reply']);
  assert.match(f.page.textContent, /openai reply/);
  f.State.setFocus('integration_claude');
  assert.match(f.page.textContent, /anthropic reply/);
  assert.doesNotMatch(f.page.textContent, /Hello Codex/);
});

test('Codex chat setup errors open the OpenAI settings and stay with Codex', async () => {
  const sections = [];
  const f = await fixture({
    chatSend: async () => { throw { code: 'missing_key', message: 'Add an OpenAI key.', settings: true }; },
    openSettingsWindow: section => { sections.push(section); },
  });
  f.State.loadIntegrationTasks();
  f.State.setFocus('agent_codex');
  const { input, send, error } = chatControls(f);
  input.value = 'Hello Codex';
  await send.fire('click');
  assert.equal(error.hidden, false);
  await f.button('Chat settings').fire('click');
  assert.deepEqual(sections, ['openai']);
  f.State.setFocus('integration_claude');
  assert.equal(error.hidden, true);
  f.State.setFocus('agent_codex');
  assert.equal(error.hidden, false);
});

test('a reply that arrives after a file drop reset the chats is discarded', async () => {
  let resolveReply;
  const f = await fixture({ chatSend: () => new Promise(resolve => { resolveReply = resolve; }) });
  const { input, send } = chatControls(f);
  input.value = 'Old question';
  await send.fire('click');
  f.State.resetChats();
  resolveReply({ text: 'Late answer' });
  await new Promise(setImmediate);
  assert.equal(f.State.chatHistory.length, 0);
  assert.doesNotMatch(f.page.textContent, /Late answer|Old question/);
  assert.equal(input.disabled, false);
});

test("Codex's Mochi signs in through Codex by default and can switch to an API key", async () => {
  let stored = false;
  const keys = [], saved = [], tested = [];
  const f = await fixture({
    secretPresent: async key => key === 'openai-api-key' && stored,
    secretSet: async key => { keys.push(key); stored = true; },
    saveSettings: async settings => { saved.push({ ...settings }); },
    chatTestConnection: async (provider, model) => { tested.push([provider, model]); },
  }, true);
  const section = f.page.all().find(el => el.attrs.id === 'openai-api');
  const select = label => section.all().find(el => el.tag === 'select' && el.attrs['aria-label'] === label);
  assert.match(section.textContent, /Codex's Mochi · OpenAI/);
  assert.equal(select("How Codex's Mochi signs in").value, 'codex');
  assert.match(section.textContent, /Codex CLI you're signed in to/);
  assert.equal(f.button('Test connection', section).disabled, false);
  await f.button('Test connection', section).fire('click');
  assert.match(section.textContent, /Codex is signed in/);
  const keyRow = section.all().find(el => el.className === 'row' && el.textContent.startsWith('API key'));
  assert.equal(keyRow.style.display, 'none');

  const signIn = select("How Codex's Mochi signs in");
  signIn.value = 'apiKey';
  await signIn.fire('change');
  assert.equal(saved.at(-1).openaiAuth, 'apiKey');
  assert.match(section.textContent, /Add an OpenAI API key/);
  assert.equal(keyRow.style.display, '');
  assert.equal(f.button('Test connection', section).disabled, true);
  section.all().find(el => el.tag === 'input').value = 'non-secret-test-value';
  await f.button('Save key', section).fire('click');
  assert.deepEqual(keys, ['openai-api-key']);
  assert.doesNotMatch(f.page.textContent, /non-secret-test-value/);
  const model = select('OpenAI chat model');
  assert.equal(model.value, 'gpt-6.1-sol');
  model.value = 'gpt-6-astra';
  await model.fire('change');
  assert.equal(saved.at(-1).openaiModel, 'gpt-6-astra');
  assert.equal(saved.at(-1).model, 'claude-opus-5');
  await f.button('Test connection', section).fire('click');
  assert.deepEqual(tested, [['openai', 'gpt-6.1-sol'], ['openai', 'gpt-6-astra']]);
  f.events.get('settings-section')('openai');
  assert.equal(section.scrolled, true);
  assert.notEqual(f.api().scrolled, true);
});

test('without a key, Claude\'s Mochi hands the question to Claude Code', async () => {
  const opened = [];
  let fail = false;
  const f = await fixture({
    chatSend: async () => { throw { code: 'missing_key', message: 'Add an Anthropic key.', settings: true }; },
    openClaudeCode: async question => { if (fail) throw 'Claude Code was not found.'; opened.push(question); },
  });
  const { input, send, error } = chatControls(f);
  input.value = 'Explain hooks';
  await send.fire('click');
  await f.button('Ask in Claude Code').fire('click');
  assert.deepEqual(opened, ['Explain hooks']);
  assert.equal(input.value, '');
  assert.match(error.textContent, /open in Claude Code/);
  assert.equal(error.hidden, false);

  fail = true;
  input.value = 'Second question';
  await send.fire('click');
  await f.button('Ask in Claude Code').fire('click');
  assert.match(error.textContent, /Claude Code was not found/);
  assert.equal(input.value, 'Second question');
});

test('Codex chat errors never offer the Claude Code hand-off', async () => {
  const f = await fixture({ chatSend: async () => { throw { code: 'missing_key', message: 'Add an OpenAI key.', settings: true }; } });
  f.State.loadIntegrationTasks();
  f.State.setFocus('agent_codex');
  const { input, send } = chatControls(f);
  input.value = 'Hello Codex';
  await send.fire('click');
  assert.equal(f.button('Ask in Claude Code'), undefined);
});

test('the Codex hooks section reports, repairs and confirms without writing silently', async () => {
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'];
  const status = (state = 'ok') => ({
    path: 'C:/Users/me/.codex/hooks.json', exists: true, problem: null,
    hookPath: 'C:/coucou-hook.exe', hookReady: true,
    events: events.map(event => ({ event, state: event === 'Stop' ? state : 'ok' })),
    installed: state === 'ok', anyInstalled: true, lastEvent: Math.round(Date.now() / 1000) - 120,
  });
  let current = status('outdated');
  const applied = [];
  let diff = '- old\n+ new\n';
  const f = await fixture({
    codexHooksStatus: async () => current,
    codexHooksPreview: async () => ({ diff, backup: 'C:/hooks.json.bak-coucou-1', settingsPath: 'x', fingerprint: 'abc' }),
    codexHooksApply: async (install, fingerprint) => { applied.push([install, fingerprint]); current = status('ok'); return 'C:/hooks.json.bak-coucou-1'; },
  }, true);
  const section = () => f.page.all().find(el => el.attrs.id === 'codex-hooks');
  assert.match(section().textContent, /7 of 8 events registered/);
  assert.match(section().textContent, /Needs repair: Stop/);
  assert.match(section().textContent, /Last Codex event: 2 min ago/);
  await f.button('Repair hooks…', section()).fire('click');
  assert.match(section().textContent, /exactly what will change/);
  assert.deepEqual(applied, []);
  await f.button('Back up and write', section()).fire('click');
  assert.deepEqual(applied, [[true, 'abc']]);
  assert.match(section().textContent, /run \/hooks and trust them/);
  await f.button('Back', section()).fire('click');
  assert.match(section().textContent, /8 of 8 events registered/);
  assert.equal(f.button('Repair hooks…', section()), undefined);

  diff = 'No change.';
  current = status('outdated');
  await f.button('Check again', section()).fire('click');
  await f.button('Repair hooks…', section()).fire('click');
  assert.match(section().textContent, /Already up to date/);
  assert.equal(applied.length, 1);
});
