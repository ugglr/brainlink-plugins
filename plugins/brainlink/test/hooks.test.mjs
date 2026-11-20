// Run: node --test test/hooks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTool } from '../scripts/lib.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// A node stub for `brainlink`, behaviour set by STUB_MODE. It logs its argv to STUB_LOG.
const STUB = (nodePath) => `#!${nodePath}
const a = process.argv.slice(2);
const mode = process.env.STUB_MODE;
if (process.env.STUB_LOG) require('fs').appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + '\\n');
if (mode === 'fail') process.exit(1);
if (mode === 'hang') { require('child_process').spawnSync('sleep', ['30']); }
const arg = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const out = (o) => console.log(JSON.stringify(o));
if (a[0] === 'get_started') console.log('rules for ' + arg('--domain'));
if (a[0] === 'list_tags') {
  // by frequency: 150 plain tags first, the when: tags last; --limit cuts the tail
  const all = Array.from({ length: 150 }, (_, i) => ({ tag: 't' + i, count: 200 - i }));
  all.push({ tag: 'when:Bash', count: 1 }, { tag: 'when:mcp__x__*', count: 1 });
  out({ items: all.slice(0, Number(arg('--limit') ?? 100)) });
}
if (a[0] === 'search') {
  const tags = a.flatMap((x, i) => (a[i - 1] === '--tags' ? [x] : []));
  if (tags.length) {
    out({ items: [
      { slug: 'bash-rule', preview: 'use rg not grep', tags: ['when:Bash', 'x'] },
      { slug: 'mcp-rule', preview: 'mcp note', tags: ['when:mcp__x__*'] },
    ] });
  }
}
`;

function env({ stub = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bl-hooks-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (stub) {
    writeFileSync(join(bin, 'brainlink'), STUB(process.execPath));
    chmodSync(join(bin, 'brainlink'), 0o755);
  }
  symlinkSync(process.execPath, join(bin, 'node')); // its own dir may hold a real `brainlink`
  return {
    root,
    data: join(root, 'data'),
    run(script, input, extra = {}) {
      const r = spawnSync(process.execPath, [join(scripts, script)], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PLUGIN_DATA: join(root, 'data'), ...extra },
      });
      return { status: r.status, out: r.stdout, err: r.stderr };
    },
  };
}
const ctx = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;
const cacheFile = (e, sid) => join(e.data, `triggers-${sid}.json`);

test('SessionStart: get_started for BRAINLINK_DOMAIN as additionalContext', () => {
  const e = env();
  const r = e.run('session-start.mjs', { session_id: 's1', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx(r.out), /rules for acme/);
});

test('SessionStart: domain from .brainlink file; a no-domain hint when absent', () => {
  const e = env();
  writeFileSync(join(e.root, '.brainlink'), 'filedom\n');
  assert.match(ctx(e.run('session-start.mjs', { session_id: 's', cwd: e.root }).out), /rules for filedom/);
  const bare = env();
  const r = bare.run('session-start.mjs', { session_id: 's', cwd: bare.root });
  assert.equal(r.status, 0);
  assert.match(ctx(r.out), /get_started\(\) without a domain.*\.brainlink/);
});

test('SessionStart: a .brainlink above the repo root is ignored', () => {
  const e = env();
  writeFileSync(join(e.root, '.brainlink'), 'outerdom\n');
  const repo = join(e.root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const r = e.run('session-start.mjs', { session_id: 's', cwd: repo });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.out, /outerdom/);
  assert.match(ctx(r.out), /no domain is set/);
});

test('SessionStart: caches when:<Tool> memories (one search, tags past the first 100), private modes', () => {
  const e = env();
  const log = join(e.root, 'log');
  e.run('session-start.mjs', { session_id: 's2', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme', STUB_LOG: log });
  assert.match(ctx(e.run('pre-tool-use.mjs', { session_id: 's2', tool_name: 'Bash' }).out), /bash-rule: use rg not grep/);
  assert.match(ctx(e.run('pre-tool-use.mjs', { session_id: 's2', tool_name: 'mcp__x__save' }).out), /mcp-rule/);
  assert.equal(e.run('pre-tool-use.mjs', { session_id: 's2', tool_name: 'Edit' }).out, '');
  assert.equal(e.run('pre-tool-use.mjs', { session_id: 'other', tool_name: 'Bash' }).out, '');
  assert.equal(statSync(cacheFile(e, 's2')).mode & 0o777, 0o600);
  assert.equal(statSync(e.data).mode & 0o777, 0o700);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.filter((c) => c[0] === 'search').length, 1);
});

test('SessionStart: prunes caches older than 7 days; drops a stale file when no triggers', () => {
  const e = env();
  mkdirSync(e.data, { recursive: true });
  const old = join(e.data, 'triggers-old.json');
  writeFileSync(old, '{}');
  const t = new Date(Date.now() - 8 * 864e5);
  utimesSync(old, t, t);
  writeFileSync(cacheFile(e, 's3'), '{"Bash":["- stale: x"]}');
  // failing CLI: no triggers, so the session's stale file must go too
  e.run('session-start.mjs', { session_id: 's3', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme', STUB_MODE: 'fail' });
  assert.ok(!existsSync(old));
  assert.ok(!existsSync(cacheFile(e, 's3')));
});

test('SessionStart: a hung CLI is killed; the run ends well inside the hook timeout', () => {
  const e = env();
  const t0 = Date.now();
  const r = e.run('session-start.mjs', { session_id: 's', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme', STUB_MODE: 'hang', BRAINLINK_HOOK_TIMEOUT_MS: '300' });
  assert.equal(r.status, 0);
  assert.match(ctx(r.out), /^Brainlink \(acme\): call get_started\(\{ domain: 'acme' \}\)/);
  assert.ok(Date.now() - t0 < 5000);
});

test('SessionStart: a brainlink in a relative PATH entry (a planted one) is never run', () => {
  const e = env({ stub: false });
  const planted = join(e.root, 'brainlink');
  writeFileSync(planted, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(join(e.root, 'ran'))}, '1');\n`);
  chmodSync(planted, 0o755);
  // With absolute entries, with none at all, and with none set.
  for (const PATH of ['.:/usr/bin:/bin', '.', '', undefined]) {
    const r = spawnSync(process.execPath, [join(scripts, 'session-start.mjs')], {
      cwd: e.root,
      input: JSON.stringify({ session_id: 's', cwd: e.root }),
      encoding: 'utf8',
      env: { ...(PATH === undefined ? {} : { PATH }), CLAUDE_PLUGIN_DATA: join(e.root, 'data'), BRAINLINK_DOMAIN: 'acme' },
    });
    assert.equal(r.status, 0, String(PATH));
    assert.ok(!existsSync(join(e.root, 'ran')), String(PATH));
    assert.match(ctx(r.stdout), /call get_started/);
  }
});

test('SessionStart: a non-executable or directory brainlink earlier in PATH is skipped, as the OS lookup would', () => {
  const e = env();
  const early = join(e.root, 'early');
  mkdirSync(join(early, 'brainlink'), { recursive: true }); // a directory named brainlink
  const early2 = join(e.root, 'early2');
  mkdirSync(early2);
  writeFileSync(join(early2, 'brainlink'), 'not executable');
  const r = spawnSync(process.execPath, [join(scripts, 'session-start.mjs')], {
    input: JSON.stringify({ session_id: 's', cwd: e.root }),
    encoding: 'utf8',
    env: { PATH: `${early}:${early2}:${join(e.root, 'bin')}:/usr/bin:/bin`, CLAUDE_PLUGIN_DATA: join(e.root, 'data'), BRAINLINK_DOMAIN: 'acme' },
  });
  assert.match(ctx(r.stdout), /^Brainlink get_started \(acme\)/);
});

test('every hook fails open: missing CLI or CLI failure leaves one get_started line; garbage stdin nothing', () => {
  const none = env({ stub: false });
  const bad = env();
  const good = env();
  for (const [e, extra] of [[none, {}], [bad, { STUB_MODE: 'fail' }]]) {
    const r = e.run('session-start.mjs', { session_id: 's', cwd: '/' }, { BRAINLINK_DOMAIN: 'acme', ...extra });
    assert.equal(r.status, 0);
    assert.equal(ctx(r.out).split('\n').length, 1);
    assert.match(ctx(r.out), /call get_started\(\{ domain: 'acme' \}\)/);
  }
  for (const script of ['session-start.mjs', 'subagent-start.mjs', 'pre-tool-use.mjs']) {
    const r = good.run(script, 'not json', { BRAINLINK_DOMAIN: 'acme' }); // CLI present and working
    assert.equal(r.status, 0, script);
  }
  rmSync(none.root, { recursive: true });
});

test('SubagentStart: the rules SessionStart cached, with no CLI; benchmark arms and other sessions get nothing', () => {
  const e = env();
  const cli = join(e.root, 'bin', 'brainlink');
  const started = {
    guidance: 'g',
    workingDomain: { rules: [{ slug: 'd1', content: 'domain rule' }], pickUpHere: 'resume here' },
    you: { rules: [{ slug: 'u1', content: 'no em-dashes' }] },
  };
  writeFileSync(cli, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(started))});\n`);
  e.run('session-start.mjs', { session_id: 's1', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme' });
  assert.equal(statSync(join(e.data, 'rules-s1.json')).mode & 0o777, 0o600);
  rmSync(cli); // no network call
  const r = e.run('subagent-start.mjs', { session_id: 's1', agent_type: 'dad:dad' });
  assert.equal(JSON.parse(r.out).hookSpecificOutput.hookEventName, 'SubagentStart');
  const text = ctx(r.out);
  assert.match(text, /^Brainlink \(acme\)/);
  assert.ok(text.indexOf('domain rule') > 0 && text.indexOf('domain rule') < text.indexOf('no em-dashes'));
  assert.doesNotMatch(text, /resume here/);
  for (const input of [{ session_id: 's1', agent_type: 'bench-receiver-cli' }, { session_id: 's2', agent_type: 'x' }]) {
    const n = e.run('subagent-start.mjs', input);
    assert.equal(n.status, 0);
    assert.equal(n.out, '');
  }
});

test('PreToolUse: needs no CLI; a corrupt cache fails open', () => {
  const none = env({ stub: false });
  mkdirSync(none.data, { recursive: true });
  writeFileSync(cacheFile(none, 's'), '{"Bash":["- r: use rg"]}');
  assert.match(ctx(none.run('pre-tool-use.mjs', { session_id: 's', tool_name: 'Bash' }).out), /use rg/);
  writeFileSync(cacheFile(none, 's'), '{not json');
  const r = none.run('pre-tool-use.mjs', { session_id: 's', tool_name: 'Bash' });
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
});

test('matchTool: exact, prefix, suffix, ordered middle, no regex from data', () => {
  assert.ok(matchTool('Bash', 'Bash'));
  assert.ok(!matchTool('Bash', 'Bash2'));
  assert.ok(matchTool('mcp__x__*', 'mcp__x__save'));
  assert.ok(!matchTool('mcp__x__*', 'mcp__y__save'));
  assert.ok(matchTool('*Edit', 'MultiEdit'));
  assert.ok(matchTool('a*b*c', 'aXbYc'));
  assert.ok(!matchTool('a*b*c', 'acb'));
  assert.ok(!matchTool('ab*bc', 'abc')); // prefix and suffix may not overlap
  assert.ok(matchTool('*', 'anything'));
  assert.ok(!matchTool('a.c', 'abc'));
  assert.ok(matchTool('a(b', 'a(b'));
});

test('SessionStart: a one-line JSON get_started over the cap is laid out and cut on a line', () => {
  const e = env();
  const big = join(e.root, 'bin', 'brainlink');
  writeFileSync(big, `#!${process.execPath}\nconsole.log(JSON.stringify({ you: { n: 'y'.repeat(20000) }, workingDomain: { rules: ['r1', 'r2'] } }));\n`);
  const text = ctx(e.run('session-start.mjs', { session_id: 's', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme' }).out);
  assert.match(text, /workingDomain/);
  assert.match(text, /r1/);
  assert.match(text, /\[Brainlink: cut to fit[^\n]*$/);
  assert.ok(Buffer.byteLength(text) <= 9500);
});

test('SessionStart: both rule sets come first, domain then user, so a cut takes state before any rule', () => {
  const e = env();
  const big = join(e.root, 'bin', 'brainlink');
  const started = {
    guidance: 'g',
    workingDomain: { pickUpHere: 'p'.repeat(6000), rules: ['domain-rule'], projects: 'x'.repeat(6000) },
    you: { facts: 'f'.repeat(6000), rules: ['user-rule'] },
    fromSubagents: [{ handoff: 'h', slugs: ['sub-save'], total: 1 }],
  };
  writeFileSync(big, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(started))});\n`);
  const text = ctx(e.run('session-start.mjs', { session_id: 's', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme' }).out);
  assert.ok(text.indexOf('domain-rule') > 0 && text.indexOf('domain-rule') < text.indexOf('user-rule'));
  assert.ok(text.indexOf('user-rule') < text.indexOf('sub-save') && text.indexOf('sub-save') < text.indexOf('ppp'));
  assert.doesNotMatch(text, /xxx|fff/);
  assert.match(text, /\[Brainlink: cut to fit[^\n]*$/);
});

test('SessionStart: rules past the cap are named in the cut note, each rule either whole or named', () => {
  const e = env();
  const big = join(e.root, 'bin', 'brainlink');
  const rule = (s) => ({ slug: s, content: `${s} says ${'z'.repeat(345)}` });
  const started = {
    guidance: 'g',
    workingDomain: { rules: Array.from({ length: 20 }, (_, i) => rule(`dom-${i}`)), pickUpHere: 'p' },
    you: { rules: Array.from({ length: 10 }, (_, i) => rule(`usr-${i}`)) },
  };
  writeFileSync(big, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(started))});\n`);
  const text = ctx(e.run('session-start.mjs', { session_id: 's', cwd: e.root }, { BRAINLINK_DOMAIN: 'acme' }).out);
  assert.ok(Buffer.byteLength(text) <= 9500);
  const note = text.split('\n').at(-1);
  const named = note.match(/binding rules: ([^.]*)\./)[1].split(', ');
  const all = [...started.workingDomain.rules, ...started.you.rules];
  const whole = all.filter((r) => text.includes(JSON.stringify(r.content))).map((r) => r.slug);
  assert.ok(whole.includes('dom-0') && named.includes('usr-9'));
  assert.deepEqual([...whole, ...named], all.map((r) => r.slug));
  assert.ok(note.includes(`dropped ${named.length} binding rules`) && note.includes("get_started({ domain: 'acme' })"));
});

const postRun = (e, input) =>
  e.run('post-tool-use.mjs', typeof input === 'string' ? input : { session_id: 'st', cwd: e.root, ...input }, { BRAINLINK_DOMAIN: 'acme' });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const nudged = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext;

test('PostToolUse: shipped work gets a one-line nudge, never a block, then 30 quiet minutes', () => {
  const e = env({ stub: false }); // no network: the hook never calls the CLI
  const r = postRun(e, bash('git commit -m x && git push'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(nudged(r), /^Brainlink \(acme\): that shipped work\..*your call\.$/);
  const state = join(e.data, 'nudge-st.json');
  assert.equal(statSync(state).mode & 0o777, 0o600);
  assert.equal(postRun(e, bash('git push')).out, ''); // nudged a moment ago
  assert.ok(nudged(postRun(e, bash('gh pr merge 5')))); // a merge always gets one
  assert.equal(postRun(e, bash('git commit -m y')).out, '');
  writeFileSync(state, JSON.stringify({ at: Date.now() - 31 * 60_000 }));
  assert.ok(nudged(postRun(e, bash('git commit -m y'))));
});

test('PostToolUse: an MCP call that changes something elsewhere, or a user answer, gets the nudge', () => {
  const sched = env({ stub: false });
  assert.match(nudged(postRun(sched, { tool_name: 'mcp__cms__admin_schedule_post', tool_input: {} })), /\(mcp__cms__admin_schedule_post\)/);
  const ask = env({ stub: false });
  assert.match(nudged(postRun(ask, { tool_name: 'AskUserQuestion', tool_input: {} })), /the user just answered a question/);
  const quiet = env({ stub: false });
  for (const tool_name of [
    'mcp__cms__admin_get_post',
    'mcp__do-apps__apps-get-deployment-status',
    'mcp__jobs__search_jobs',
    'mcp__playwright__browser_click',
    'mcp__playwright__browser_close',
    'mcp__claude-in-chrome__tabs_create_mcp',
    'mcp__chrome-devtools__close_page',
    'mcp__cms__complete_authentication',
    'mcp__claude_ai_brainlink__create_domain',
    'Read',
  ]) {
    assert.equal(postRun(quiet, { tool_name, tool_input: {} }).out, '', tool_name);
  }
  // The first verb decides, in any separator style.
  for (const tool_name of ['mcp__jobs__save_job', 'mcp__do-apps__apps-update', 'mcp__mongodb-stage__update-many']) {
    const w = env({ stub: false });
    assert.ok(nudged(postRun(w, { tool_name, tool_input: {} })), tool_name);
  }
});

test('PostToolUse: a Brainlink write does not silence the next nudge; subagents get none', () => {
  const e = env({ stub: false });
  assert.equal(postRun(e, { tool_name: 'mcp__claude_ai_brainlink__open_thread', tool_input: {} }).out, '');
  assert.equal(postRun(e, bash('brainlink save -')).out, '');
  assert.ok(nudged(postRun(e, bash('git commit -m feat')))); // the write came before the work
  const sub = env({ stub: false });
  for (const agent_type of ['general-purpose', 'bench-receiver-cli']) {
    assert.equal(postRun(sub, { ...bash('git commit -m x'), agent_id: 'a1', agent_type }).out, '', agent_type);
  }
  assert.ok(nudged(postRun(sub, bash('git commit -m x')))); // the main thread's window was untouched
});

test('PostToolUse: reads, edits, searches and mentions are not work; no domain or garbage does nothing', () => {
  const e = env({ stub: false });
  for (const input of [
    bash('git status'),
    bash('echo "then git commit"'),
    { tool_name: 'Edit', tool_input: { file_path: 'a' } },
    { tool_name: 'mcp__brainlink__search', tool_input: {} },
  ]) {
    assert.equal(postRun(e, input).out, '', JSON.stringify(input));
  }
  assert.ok(nudged(postRun(e, bash('cd x && git -C y commit -m z'))));
  const bare = env({ stub: false });
  assert.equal(bare.run('post-tool-use.mjs', { session_id: 'st', cwd: bare.root, ...bash('git commit -m x') }).out, '');
  const g = postRun(e, 'not json');
  assert.equal(g.status, 0);
  assert.equal(g.out, '');
});
