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
  const listeners = {};
  const sounds = [], timers = [], declined = [], acked = [];
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
          onEvent: (event, fn) => { listeners[event] = fn; },
          Bridge: { approvalDecline: (id) => declined.push(id), approvalAck: (id) => acked.push(id) },
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
    dropPin() {},
  };
  const hooks = load(resolve(root, 'island/hooks.ts'));
  hooks.registerHookHandlers(island);
  const listener = (payload) => listeners.hook(payload);
  const send = (name, session = 'a', turn = 'a1', extra = {}) => listener({
    coucou_agent: 'codex', hook_event_name: name, session_id: session,
    turn_id: turn, cwd: `C:/${session}`, ...extra,
  });
  const task = () => State.tasks.find((entry) => entry.id === 'agent_codex');
  return { State, send, task, sounds, timers, declined, acked, listener, listeners, hooks };
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
  // "Open in Codex" follows the chat the pill shows.
  assert.equal(f.task().sessionId, 'b');
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
  // Agents other than Claude Code and Codex still ask in their own terminal.
  f.listener({ coucou_agent: 'gemini', hook_event_name: 'PermissionRequest', request_id: 'approval-test' });
  assert.deepEqual(f.declined, ['approval-test']);
  assert.equal(f.State.pendingApproval, null);
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

// ── Codex approvals and the Codex pill, on a par with Claude Code ─────────────

test('a Codex permission request gets the approval card on the Codex pill', () => {
  const f = fixture();
  f.send('UserPromptSubmit', 'a', 'a1', { cwd: 'C:/work/my-app', prompt: 'fix it' });
  f.send('PermissionRequest', 'a', 'a1', {
    request_id: 'r1', cwd: 'C:/work/my-app', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' },
  });
  assert.deepEqual(f.acked, ['r1']);
  assert.deepEqual(f.declined, []);
  assert.equal(f.State.view, 'approval');
  assert.equal(f.State.pendingApproval.pillId, 'agent_codex');
  assert.equal(f.State.pendingApproval.command, 'Bash · npm install left-pad');
  assert.equal(f.task().state, 'approval');
  assert.equal(f.task().name, 'Codex');
  assert.equal(f.task().sessionCwd, 'C:/work/my-app');
  assert.equal(f.State.isPinned, true);
  assert.ok(f.sounds.includes('approval'));
  // Other work on the turn keeps the card and the pill asking.
  f.send('PostToolUse', 'a', 'a1', { tool_name: 'Read' });
  assert.equal(f.task().state, 'approval');
  assert.equal(f.State.pendingApproval.requestId, 'r1');
  // After the island's Allow or Deny, the pill goes back to work.
  f.hooks.approvalAnswered();
  assert.equal(f.State.pendingApproval, null);
  assert.equal(f.task().state, 'working');
  assert.equal(f.State.isPinned, false);
});

test('a Codex request while Claude Code is focused badges the Codex pill instead of taking over', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.State.setFocus('integration_claude');
  f.State.mode = 'hidden';
  f.State.view = 'overview';
  f.send('PermissionRequest', 'a', 'a1', {
    request_id: 'r2', tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: src/main.rs\n@@\n*** Add File: docs/new.md\n*** End Patch' },
  });
  assert.equal(f.State.focusId, 'integration_claude');
  assert.equal(f.task().pillBadge, 'approval');
  assert.equal(f.State.mode, 'compact');
  assert.equal(f.State.view, 'overview');
  assert.equal(f.State.pendingApproval.command, 'apply_patch · main.rs, new.md');
  // A second request never replaces the first: it goes straight back to Codex.
  f.send('PermissionRequest', 'b', 'b1', { request_id: 'r3', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(f.declined, ['r3']);
  assert.equal(f.State.pendingApproval.requestId, 'r2');
});

test('a Codex turn that moves on releases its pending request and takes the card down', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('PermissionRequest', 'a', 'a1', { request_id: 'r4', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.equal(f.State.view, 'approval');
  // Another chat finishing does not touch this chat's request.
  f.send('Stop', 'b', 'b1', { last_assistant_message: 'other chat' });
  assert.equal(f.State.pendingApproval?.requestId, 'r4');
  assert.equal(f.State.view, 'approval');
  f.send('Stop', 'a', 'a1', { last_assistant_message: 'done anyway' });
  assert.deepEqual(f.declined, ['r4']);
  assert.equal(f.State.pendingApproval, null);
  assert.equal(f.State.noteMessage, 'Handled in Codex.');
  assert.equal(f.State.view, 'finished');
  assert.equal(f.task().state, 'finished');
});

test('when Codex stops waiting, the card comes down with a note', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('PermissionRequest', 'a', 'a1', { request_id: 'r5', tool_name: 'Bash', tool_input: { command: 'make' } });
  f.listeners['approval-gone']({ requestId: 'someone-else' });
  assert.equal(f.State.pendingApproval.requestId, 'r5');
  f.listeners['approval-gone']({ requestId: 'r5' });
  assert.equal(f.State.pendingApproval, null);
  assert.equal(f.State.view, 'note');
  assert.equal(f.State.noteMessage, 'Handled in Codex.');
  assert.equal(f.task().state, 'thinking');
  assert.equal(f.State.isPinned, false);
});

test('an unanswered Codex request times out and gives the pill back', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  f.send('PermissionRequest', 'a', 'a1', { request_id: 'r6', tool_name: 'Bash', tool_input: { command: 'make' } });
  f.timers.forEach((callback) => callback());
  assert.equal(f.State.pendingApproval, null);
  assert.equal(f.task().state, 'thinking');
  assert.equal(f.State.view, 'overview');
});

test('Claude Code approvals keep their card and answer path', () => {
  const f = fixture();
  f.listener({ hook_event_name: 'UserPromptSubmit', cwd: 'C:/work/site', prompt: 'p', session_id: 's' });
  f.listener({
    hook_event_name: 'PermissionRequest', cwd: 'C:/work/site', session_id: 's', request_id: 'c1',
    tool_name: 'Write', tool_input: { file_path: 'C:/work/site/.env' },
  });
  const claude = f.State.tasks.find((task) => task.id === 'integration_claude');
  assert.equal(f.State.pendingApproval.pillId, 'integration_claude');
  assert.equal(f.State.pendingApproval.command, 'Write · C:/work/site/.env');
  assert.equal(claude.state, 'approval');
  assert.equal(f.State.view, 'approval');
  assert.deepEqual(f.acked, ['c1']);
  f.hooks.approvalAnswered();
  assert.equal(claude.state, 'working');
  assert.equal(f.State.pendingApproval, null);
  // Claude Code's session ending also releases a request it left behind.
  f.listener({ hook_event_name: 'PermissionRequest', cwd: 'C:/work/site', session_id: 's', request_id: 'c2', tool_name: 'Bash', tool_input: { command: 'ls' } });
  f.listener({ hook_event_name: 'SessionEnd', session_id: 's' });
  assert.deepEqual(f.declined, ['c2']);
  assert.equal(f.State.pendingApproval, null);
});

test('the Codex pill keeps its name and settles like Claude Code after a turn', () => {
  const f = fixture();
  f.send('SessionStart', 'a', undefined, { cwd: 'C:/work/my-app' });
  assert.deepEqual(f.sounds, ['work']);
  f.send('UserPromptSubmit', 'a', 'a1', { cwd: 'C:/work/my-app', prompt: 'hello' });
  assert.equal(f.task().name, 'Codex');
  assert.equal(f.task().sessionCwd, 'C:/work/my-app');
  f.send('PreToolUse', 'a', 'a1', { cwd: 'C:/work/my-app', tool_name: 'Bash', tool_input: { command: 'rg TODO src' } });
  assert.equal(f.task().steps.at(-1), 'Cherche · rg TODO src');
  f.send('Stop', 'a', 'a1', { cwd: 'C:/work/my-app', last_assistant_message: 'done' });
  assert.equal(f.task().state, 'finished');
  assert.equal(f.task().sessionId, 'a');
  f.timers.forEach((callback) => callback());
  assert.equal(f.task().state, 'idle');
  assert.equal(f.task().steps.at(-1), 'done');
  assert.equal(f.task().name, 'Codex');
  // The settled turn stays quiet: late events cannot revive it.
  f.send('PostToolUse', 'a', 'a1', { cwd: 'C:/work/my-app' });
  assert.equal(f.task().state, 'idle');
  f.send('SessionEnd', 'a', undefined);
  assert.equal(f.task().name, 'Codex');
  assert.equal(f.task().sessionCwd, null);
  assert.equal(f.task().sessionId, null);
  assert.equal(f.task().steps.length, 0);
});

test('Codex tool steps read like the macOS ticker, and rate limits sound once', () => {
  const f = fixture();
  f.send('UserPromptSubmit');
  const step = (toolName, toolInput) => {
    f.send('PreToolUse', 'a', 'a1', { tool_name: toolName, tool_input: toolInput });
    return f.task().steps.at(-1);
  };
  assert.equal(step('apply_patch', { command: '*** Begin Patch\n*** Update File: C:/repo/src/lib.rs\n*** End Patch' }), 'Modifie · lib.rs');
  assert.equal(step('mcp__github__search_issues', {}), 'github · search_issues');
  assert.equal(step('Bash', { command: 'cargo test -p coucou\n--lib' }), 'Teste · cargo test -p coucou --lib');
  assert.equal(step('PowerShell', { command: 'Get-Content README.md' }), 'Lit · Get-Content README.md');
  assert.equal(step('update_plan', {}), 'Tâches');
  assert.equal(step('shell', { command: ['powershell', '-Command', 'dir'] }), 'Exécute · powershell -Command dir');
  f.send('Notification', 'a', 'a1', { message: 'Rate limit reached' });
  f.send('Notification', 'a', 'a1', { message: 'Rate limit reached' });
  assert.equal(f.task().state, 'ratelimit');
  assert.deepEqual(f.sounds.filter((sound) => sound === 'rate'), ['rate']);
});
