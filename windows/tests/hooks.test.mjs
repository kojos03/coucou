import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real hook listener and AppState, replacing only native I/O,
// sounds and the window. No browser or extra test dependency is required.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
function fixture() {
  let listener;
  const sounds = [], timers = [], declined = [];
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const context = {
      exports, performance,
      window: { setTimeout: (fn) => timers.push(fn), clearTimeout() {} },
      require: (name) => {
        if (name.endsWith('/bridge')) return {
          onEvent: (_, fn) => { listener = fn; },
          Bridge: { approvalDecline: (id) => declined.push(id) },
        };
        if (name.endsWith('/sound')) return { Sound: { play: (sound) => sounds.push(sound) } };
        return load(resolve(dirname(file), `${name}.ts`));
      },
    };
    vm.runInNewContext(compiled, context, { filename: file });
    return exports;
  }
  const { State } = load(resolve(root, 'core/state.ts'));
  State.loadIntegrationTasks();
  const island = {
    alert(view) { State.view = view; State.mode = 'expanded'; },
    setView(view) { State.view = view; },
    reveal() { State.mode = 'compact'; },
  };
  load(resolve(root, 'island/hooks.ts')).registerHookHandlers(island);
  const send = (name, session = 'a', turn = 'a1', extra = {}) => listener({
    coucou_agent: 'codex', hook_event_name: name, session_id: session,
    turn_id: turn, cwd: `C:/${session}`, ...extra,
  });
  const task = () => State.tasks.find((entry) => entry.id === 'agent_codex');
  return { State, send, task, sounds, timers, declined, listener };
}

test('repeated turn clears completion, badge and old steps, and returns to overview', () => {
  const f = fixture();
  f.send('UserPromptSubmit', 'a', 'a1', { prompt: 'first prompt' });
  f.send('Stop', 'a', 'a1', { last_assistant_message: 'first result' });
  assert.equal(f.State.view, 'finished');
  f.send('UserPromptSubmit', 'a', 'a2', { prompt: 'second prompt' });
  assert.equal(f.task().state, 'thinking');
  assert.equal(f.task().steps.join('|'), 'second prompt');
  assert.equal(f.task().pillBadge, null);
  assert.equal(f.State.view, 'overview');
  f.send('PreToolUse', 'a', 'a2', { tool_name: 'Read', tool_input: { path: 'C:/new.txt' } });
  assert.equal(f.task().state, 'working');
  assert.equal(f.task().steps.at(-1), 'Lit · new.txt');
  f.send('Stop', 'a', 'a2', { last_assistant_message: 'second result' });
  assert.equal(f.State.view, 'finished');
  assert.equal(f.task().steps.at(-1), 'second result');
  assert.equal(f.State.tasks.filter((task) => task.id === 'agent_codex').length, 1);
});

test('closing a completed chat preserves another working chat and its activity', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('Stop', 'a', 'a1', { last_assistant_message: 'A done' });
  f.send('UserPromptSubmit', 'b', 'b1', { prompt: 'B prompt' });
  f.send('PreToolUse', 'b', 'b1', { tool_name: 'B tool' });
  f.send('SessionEnd', 'a', undefined);
  assert.equal(f.task().state, 'working');
  assert.equal(f.task().steps.at(-1), 'B tool');
  assert.equal(f.task().sessionCwd, 'C:/b');
  assert.equal(f.State.view, 'overview');
});

test('late Stop, failure, tool, subagent and prompt events cannot replace a newer turn', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('UserPromptSubmit', 'a', 'a2', { prompt: 'new turn' });
  f.send('PreToolUse', 'a', 'a2', { tool_name: 'current tool' });
  for (const name of ['Stop', 'StopFailure', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'UserPromptSubmit']) {
    f.send(name, 'a', 'a1', { last_assistant_message: 'stale', prompt: 'stale' });
    assert.equal(f.task().state, 'working', name);
    assert.equal(f.task().steps.join('|'), 'new turn|current tool', name);
  }
  assert.equal(f.sounds.length, 0);
});

test('any active chat takes priority over results; the last completion opens the card', () => {
  const f = fixture();
  f.send('UserPromptSubmit', 'a', 'a1', { prompt: 'A active' });
  f.send('UserPromptSubmit', 'b', 'b1', { prompt: 'B active' });
  f.send('Stop', 'b', 'b1', { last_assistant_message: 'B done' });
  assert.equal(f.task().state, 'thinking');
  assert.equal(f.task().steps.at(-1), 'A active');
  assert.notEqual(f.State.view, 'finished');
  f.send('Stop', 'a', 'a1', { last_assistant_message: 'A done' });
  assert.equal(f.State.view, 'finished');
  assert.equal(f.task().steps.at(-1), 'A done');
  assert.equal(f.sounds.join('|'), 'finish');
});

test('background tools do not steal selection from the most recent active prompt', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('UserPromptSubmit', 'b', 'b1', { prompt: 'B selected' });
  f.send('PreToolUse', 'a', 'a1', { tool_name: 'A background' });
  assert.equal(f.task().steps.at(-1), 'B selected');
  f.send('SessionEnd', 'b', undefined);
  assert.equal(f.task().steps.at(-1), 'A background');
  assert.equal(f.task().state, 'working');
});

test('late events after completion do not resurrect work or repeat the finish sound', () => {
  const f = fixture();
  f.send('Stop', 'a', 'a1', { last_assistant_message: 'done' });
  for (const name of ['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart']) f.send(name);
  assert.equal(f.task().state, 'finished');
  assert.equal(f.task().steps.join('|'), 'done');
  assert.equal(f.sounds.join('|'), 'finish');
});

test('ended session stays idle after late events but can start a fresh turn', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('SessionEnd');
  for (const name of ['Stop', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']) f.send(name);
  assert.equal(f.task().state, 'idle');
  assert.equal(f.task().steps.length, 0);
  f.send('UserPromptSubmit', 'a', 'a2', { prompt: 'resumed' });
  assert.equal(f.task().state, 'thinking');
});

test('recovers mid-turn; delayed prompt does not overwrite an observed tool', () => {
  const f = fixture();
  f.send('PreToolUse', 'a', 'a1', { tool_name: 'first observed tool' });
  f.send('UserPromptSubmit', 'a', 'a1', { prompt: 'late prompt' });
  assert.equal(f.task().state, 'working');
  assert.equal(f.task().steps.join('|'), 'first observed tool');
  f.send('Stop', 'a', 'a1', { last_assistant_message: 'recovered' });
  assert.equal(f.State.view, 'finished');
});

test('unidentified or mismatched completion cannot finish an identified turn', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.listener({ coucou_agent: 'codex', hook_event_name: 'Stop' });
  f.send('Stop', 'a', 'unknown');
  f.send('Stop', 'a', null);
  assert.equal(f.task().state, 'thinking');
});

test('final assistant text takes precedence, with message and generic fallbacks', () => {
  for (const [payload, expected] of [
    [{ last_assistant_message: 'final', message: 'old' }, 'final'],
    [{ last_assistant_message: null, message: 'fallback' }, 'fallback'],
    [{}, 'Session finished'],
  ]) {
    const f = fixture();
    f.send('UserPromptSubmit', 'a', 'a1', { prompt: 'prompt must not be the result' });
    f.send('Stop', 'a', 'a1', payload);
    assert.equal(f.task().steps.at(-1), expected);
  }
});

test('new work preserves an explicitly opened settings view', () => {
  const f = fixture();
  f.State.mode = 'expanded';
  f.State.view = 'settings';
  f.send('UserPromptSubmit');
  assert.equal(f.State.view, 'settings');
});

test('completion while another pill is focused sets a badge without stealing focus', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.State.setFocus('integration_claude');
  f.send('Stop');
  assert.equal(f.task().pillBadge, 'finished');
  assert.equal(f.State.focusId, 'integration_claude');
  assert.notEqual(f.State.view, 'finished');
  f.send('UserPromptSubmit', 'a', 'a2');
  assert.equal(f.task().pillBadge, null);
});

test('legacy Codex payloads still support sequential turns', () => {
  const f = fixture();
  const send = (name) => f.listener({ coucou_agent: 'codex', hook_event_name: name });
  send('UserPromptSubmit'); send('Stop'); send('UserPromptSubmit');
  assert.equal(f.task().state, 'thinking');
  assert.equal(f.State.view, 'overview');
});

test('Claude completion and external permission decline retain their existing behavior', () => {
  const f = fixture();
  f.listener({ hook_event_name: 'UserPromptSubmit', prompt: 'Claude prompt' });
  f.listener({ hook_event_name: 'Stop', message: 'Claude result' });
  const claude = f.State.tasks.find((task) => task.id === 'integration_claude');
  assert.equal(claude.state, 'finished');
  assert.equal(claude.steps.at(-1), 'Claude result');
  assert.equal(f.State.view, 'finished');
  f.timers.forEach((callback) => callback());
  assert.equal(claude.state, 'idle');
  f.send('PermissionRequest', 'a', 'a1', { request_id: 'approval-test' });
  assert.deepEqual(f.declined, ['approval-test']);
});

test('other external agents keep the folder used by terminal and VS Code actions', () => {
  const f = fixture();
  const send = (name, extra = {}) => f.listener({ coucou_agent: 'gemini', hook_event_name: name, ...extra });
  send('UserPromptSubmit', { cwd: 'C:/gemini project', prompt: 'Gemini prompt' });
  assert.equal(f.State.focusId, 'agent_gemini');
  assert.equal(f.State.focusTask.sessionCwd, 'C:/gemini project');
  send('PreToolUse', { tool_name: 'Read', tool_input: {} });
  assert.equal(f.State.focusTask.sessionCwd, 'C:/gemini project');
  send('PreToolUse', { cwd: 'C:/gemini other', tool_name: 'Read', tool_input: {} });
  assert.equal(f.State.focusTask.sessionCwd, 'C:/gemini other');
  send('Stop', { message: 'Gemini result' });
  assert.equal(f.State.view, 'finished');
  assert.equal(f.State.focusTask.sessionCwd, 'C:/gemini other');
  assert.equal(f.task().sessionCwd ?? null, null);
});

test('Claude Code and Codex keep their own pills while the ticker shows the project', () => {
  const f = fixture();
  const claude = () => f.State.tasks.find((task) => task.id === 'integration_claude');
  assert.equal(claude().name, 'Claude Code');
  assert.equal(f.task().name, 'Codex');
  f.listener({ hook_event_name: 'UserPromptSubmit', cwd: 'C:/work/my-app', prompt: 'hi' });
  assert.equal(claude().name, 'my-app');
  f.listener({ hook_event_name: 'SessionEnd' });
  assert.equal(claude().name, 'Claude Code');
  assert.deepEqual(Array.from(f.State.tasks.slice(0, 2), (task) => task.id), ['integration_claude', 'agent_codex']);
});

test('pause ignores Codex lifecycle events and immediately declines pending approval', () => {
  const f = fixture();
  f.State.paused = true;
  f.send('UserPromptSubmit');
  f.send('PermissionRequest', 'a', 'a1', { request_id: 'paused' });
  assert.equal(f.task().state, 'idle');
  assert.deepEqual(f.declined, ['paused']);
});
