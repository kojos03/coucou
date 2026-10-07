import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// The GitHub pulse card (upstream #181, #185, #187): My PRs, To review and
// Default branch CI, the lists behind them, the contribution grid, and which
// changes badge the pill.

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
  const sounds = [];
  const dom = {
    h: (tag, attrs, ...children) => new Element(tag, attrs, children),
    clear: (el) => { el.children = []; el.ownText = ''; },
    svg: () => new Element('svg'),
    dot: (color) => new Element('i', { class: 'dot', color }),
  };
  const host = () => ({ el: new Element('div'), sync() {} });
  const ctx = {
    console, Math, Date, URL, setTimeout: () => 0, clearTimeout() {},
    performance: { now: () => 1000 },
    window: { setTimeout: () => 0, clearTimeout() {}, devicePixelRatio: 1 },
    document: { getElementById: () => new Element('main'), createElement: (t) => new Element(t) },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
    Path2D: class { moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} addPath() {} },
    resolve(name, from) {
      if (name.startsWith('@tauri-apps/')) return {};
      if (name.endsWith('.css')) return {};
      if (name.endsWith('/dom')) return dom;
      if (name.endsWith('/sound')) return { Sound: { play: (s) => sounds.push(s) } };
      if (name.endsWith('/minibots')) return { createMiniBot: () => new Element('span'), pruneMiniBots() {} };
      if (name.endsWith('/upload')) return { buildUpload: host, buildUploading: host, buildChoose: host };
      if (name.endsWith('/chat')) return { buildPrompt: host };
      return load(resolve(dirname(from), `${name}.ts`), cache, ctx);
    },
  };
  const calls = [];
  const { Bridge } = load(resolve(root, 'core/bridge.ts'), cache, ctx);
  Bridge.openUrl = async (url) => { calls.push(['open', url]); };
  Bridge.githubRefresh = async (kind) => { calls.push(['refresh', kind]); };
  Bridge.usageRefresh = async () => {};
  const { State } = load(resolve(root, 'core/state.ts'), cache, ctx);
  State.settings.activeIntegrations = ['integration_github'];
  State.loadIntegrationTasks();
  State.integrations.integration_github = {
    data: { totalStars: 1234, totalRepos: 18 }, error: null, loaded: true, configured: true,
  };
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const views = load(resolve(root, 'views/views.ts'), cache, ctx);
  const overview = views.buildViews(actions, () => {}).get('overview');
  Object.assign(State, { view: 'overview', mode: 'expanded' });
  State.notify = () => overview.sync();
  const find = (cls) => overview.el.all().filter((el) => el.className.split(' ').includes(cls));
  return { State, overview, calls, cache, ctx, sounds, find };
}

const pr = (repo, number, ci, extra = {}) => ({
  id: `${repo}#${number}`, title: `Change ${number}`, url: `https://github.com/${repo}/pull/${number}`,
  repo, number, isDraft: false, ci, review: 'unknown', headSha: 'abc', ...extra,
});
const PULSE = {
  login: 'kojos03',
  myPrs: [pr('kojos03/coucou', 12, 'failure'), pr('kojos03/coucou', 14, 'pending', { isDraft: true }),
    pr('kojos03/site', 3, 'success'), pr('kojos03/site', 4, 'success')],
  toReview: [pr('Louis-CFM/coucou', 190, 'unknown', { review: 'pending' })],
  mainCi: [
    { repo: 'kojos03/coucou', url: 'https://github.com/kojos03/coucou', branch: 'main', ci: 'failure', headSha: 'a' },
    { repo: 'kojos03/site', url: 'https://github.com/kojos03/site/', branch: 'master', ci: 'success', headSha: 'b' },
  ],
  fetchedAt: 0,
};

/** 30 full weeks from Sunday 1 March 2026 and a week in progress (Sun–Tue). */
function activity() {
  const weeks = [];
  const start = Date.UTC(2026, 2, 1);
  for (let w = 0; w < 31; w++) {
    const days = [];
    for (let d = 0; d < (w === 30 ? 3 : 7); d++) {
      const date = new Date(start + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
      days.push({ date, count: (w + d) % 5, level: (w + d) % 5, weekday: d });
    }
    weeks.push(days);
  }
  return { total: 1502, weeks, fetchedAt: 0 };
}

test('the card sums up PRs, reviews and default-branch CI, with stars and the week', () => {
  const f = fixture();
  f.State.githubPulse = PULSE;
  f.State.githubActivity = activity();
  f.State.setFocus('integration_github');
  f.overview.sync();
  const stats = f.find('gh-stat');
  assert.deepEqual(stats.map((s) => s.textContent), [
    'My PRs4 · 1 failing', 'To review1', 'Default branch CI1 failing',
  ]);
  const week = f.find('gh-week-btn')[0];
  assert.match(week.textContent, /★ 1\.2k/);
  assert.equal(f.find('gh-week')[0].children.length, 7, 'the last seven days');
  assert.deepEqual(f.calls.filter((c) => c[0] === 'refresh'), [['refresh', 'pulse']]);
});

test('the summary follows the worst state, and says when there is nothing', async () => {
  const f = fixture();
  const views = load(resolve(root, 'views/integrations.ts'), f.cache, f.ctx);
  assert.equal(views.worstCi(['success', 'pending', 'unknown']), 'pending');
  assert.equal(views.worstCi(['success', 'failure', 'pending']), 'failure');
  assert.equal(views.worstCi([]), 'unknown');
  f.State.githubPulse = { ...PULSE, myPrs: [pr('a/b', 1, 'pending'), pr('a/b', 2, 'success')], toReview: [], mainCi: [] };
  f.State.setFocus('integration_github');
  f.overview.sync();
  assert.deepEqual(f.find('gh-stat').map((s) => s.textContent), [
    'My PRs2 · running', 'To review0', 'Default branch CIno repos',
  ]);
  f.State.githubPulse = { ...PULSE, myPrs: [], mainCi: [PULSE.mainCi[1]] };
  f.overview.sync();
  assert.deepEqual(f.find('gh-stat').map((s) => s.textContent), [
    'My PRs0', 'To review1', 'Default branch CIall green',
  ]);
});

test('each row opens its list; rows open on github.com only', () => {
  const f = fixture();
  f.State.githubPulse = { ...PULSE, myPrs: [...PULSE.myPrs, pr('evil/x', 9, 'success', { url: 'https://evil.example/pull/9' })] };
  f.State.setFocus('integration_github');
  f.overview.sync();
  f.find('gh-stat')[0].fire('click');
  const rows = f.find('gh-row');
  assert.equal(rows.length, 5);
  assert.match(f.overview.el.textContent, /My PRs/);
  assert.equal(rows[0].querySelector('.gh-ref').textContent, 'coucou#12');
  assert.equal(rows[1].querySelector('.gh-draft').textContent, 'Draft');
  assert.ok(f.find('gh-list')[0].className.includes('fade'), 'more than three rows fade out');
  rows[0].fire('click');
  assert.deepEqual(f.calls.at(-1), ['open', 'https://github.com/kojos03/coucou/pull/12']);
  const before = f.calls.length;
  rows[4].fire('click');
  assert.equal(f.calls.length, before, 'a link off github.com stays closed');

  // Back, then the default-branch list: words, and a click opens Actions.
  f.find('int-back')[0].fire('click');
  assert.equal(f.find('gh-row').length, 0);
  f.find('gh-stat')[2].fire('click');
  const repos = f.find('gh-row');
  assert.deepEqual(repos.map((r) => r.textContent), ['coucoumainfailing', 'sitemasterpassing']);
  assert.ok(!f.find('gh-list')[0].className.includes('fade'));
  repos[1].fire('click');
  assert.deepEqual(f.calls.at(-1), ['open', 'https://github.com/kojos03/site/actions']);

  // An empty list says so; the review list has no CI dots.
  f.find('int-back')[0].fire('click');
  f.State.githubPulse = { ...PULSE, toReview: [] };
  f.overview.sync();
  f.find('gh-stat')[1].fire('click');
  assert.match(f.overview.el.textContent, /To reviewNothing here/);
});

test('the activity grid shows 23 weeks; hover shows a day, a click pins it', () => {
  const f = fixture();
  f.State.githubPulse = PULSE;
  f.State.githubActivity = activity();
  f.State.setFocus('integration_github');
  f.overview.sync();
  f.find('gh-week-btn')[0].fire('click');
  assert.deepEqual(f.calls.filter((c) => c[0] === 'refresh').at(-1), ['refresh', 'activity']);
  const cols = f.find('gh-col');
  assert.equal(cols.length, 23);
  assert.ok(cols.every((c) => c.children.length === 7));
  assert.equal(cols[22].children.filter((c) => c.className === 'gh-day empty').length, 4, 'the week in progress');
  const label = f.find('gh-activity-label')[0];
  assert.equal(label.textContent, '1,502 past year · 18 repos');
  const day = cols[22].children[1]; // Monday of the week in progress
  day.fire('mouseenter');
  assert.match(label.textContent, /^[A-Z][a-z]{2} \d+ · (No contributions|1 contribution|\d+ contributions)$/);
  const hovered = label.textContent;
  day.fire('mouseleave');
  assert.equal(label.textContent, '1,502 past year · 18 repos');
  day.fire('click');
  cols[0].children[0].fire('mouseenter');
  cols[0].children[0].fire('mouseleave');
  assert.equal(label.textContent, hovered, 'a pinned day stays after hovering another');
  day.fire('click');
  assert.equal(label.textContent, '1,502 past year · 18 repos');
  label.fire('click');
  assert.deepEqual(f.calls.at(-1), ['open', 'https://github.com/kojos03']);
});

test('day labels read like GitHub', () => {
  const f = fixture();
  const { dayLabel, lastDays } = load(resolve(root, 'views/integrations.ts'), f.cache, f.ctx);
  assert.equal(dayLabel({ date: '2026-10-07', count: 0, level: 0, weekday: 3 }), 'Oct 7 · No contributions');
  assert.equal(dayLabel({ date: '2026-01-02', count: 1, level: 1, weekday: 5 }), 'Jan 2 · 1 contribution');
  assert.equal(dayLabel({ date: '2026-12-31', count: 12, level: 4, weekday: 4 }), 'Dec 31 · 12 contributions');
  const a = activity();
  assert.deepEqual(lastDays(a, 3).map((d) => d.weekday), [0, 1, 2]);
  assert.equal(lastDays(a, 7)[0].weekday, 3);
});

test('alerts: one badge and one sound, red CI over a review over green CI', () => {
  const f = fixture();
  const { gitHubAlert } = load(resolve(root, 'island/integrations.ts'), f.cache, f.ctx);
  const badge = () => f.State.tasks.find((t) => t.id === 'integration_github').pillBadge;
  const revealed = [];
  f.State.setFocus('integration_claude');

  gitHubAlert([{ kind: 'ciPassed', id: 'a#1' }, { kind: 'reviewRequested', id: 'a#2' }, { kind: 'ciFailed', id: 'a#3' }],
    (b) => revealed.push(b));
  assert.equal(badge(), 'error');
  assert.deepEqual(f.sounds, ['error']);
  assert.deepEqual(revealed, ['error']);

  f.State.setPillBadge('integration_github', null);
  gitHubAlert([{ kind: 'ciPassed', id: 'a#1' }, { kind: 'reviewRequested', id: 'a#2' }]);
  assert.equal(badge(), 'finished');
  assert.equal(f.sounds.at(-1), 'question');

  f.State.setPillBadge('integration_github', null);
  gitHubAlert([{ kind: 'mainFailed', id: 'a/b' }]);
  assert.equal(badge(), 'error');

  // Nothing new: no badge, no sound.
  f.State.setPillBadge('integration_github', null);
  const n = f.sounds.length;
  gitHubAlert([]);
  assert.equal(badge(), null);
  assert.equal(f.sounds.length, n);

  // The GitHub card already on screen: the sound, but no badge.
  f.State.setFocus('integration_github');
  gitHubAlert([{ kind: 'ciPassed', id: 'a#1' }], (b) => revealed.push(b));
  assert.equal(badge(), null);
  assert.equal(f.sounds.at(-1), 'finish');
  assert.equal(revealed.length, 1);
});
