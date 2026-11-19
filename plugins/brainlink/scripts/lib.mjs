// Shared helpers for the Brainlink hooks. Every hook fails open: any error
// means exit 0 with no output, so a broken hook never blocks Claude Code, and
// no hook blocks on purpose either.
// The `brainlink` CLI holds its own login; nothing secret is read or printed here.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const CAP_BYTES = 1024; // injected tool-trigger memories
export const SESSION_CAP_BYTES = 9500; // get_started; the docs cap a hook string at 10,000 chars

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// The CLI is found here and spawned by absolute path, never by bare name: on
// Windows a bare name is looked up in the working directory first, and that is
// the project, where a cloned repo could plant its own `brainlink`. Only
// absolute PATH entries count (`.` or an empty entry is the project too), and
// only an executable file, as the OS lookup would. The CLI inherits the same
// clean PATH. The working directory is kept: the CLI picks a pinned account
// from it. A list, not a string: ''.split() would give back [''], the project.
const SAFE_DIRS = (process.env.PATH || '').split(delimiter).filter(isAbsolute);

function cliPath() {
  for (const dir of SAFE_DIRS) {
    const p = join(dir, 'brainlink');
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* not here, or not executable */
    }
  }
  return null;
}

// Run `brainlink <args>`; returns stdout, or null on a missing CLI, timeout,
// non-zero exit (not logged in, server down) or empty output.
export function brainlink(args, timeoutMs) {
  try {
    const cli = cliPath();
    if (!cli) return null;
    const r = spawnSync(cli, args, {
      env: { ...process.env, PATH: SAFE_DIRS.join(delimiter) },
      encoding: 'utf8',
      timeout: Math.min(timeoutMs, Number(process.env.BRAINLINK_HOOK_TIMEOUT_MS) || Infinity),
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) return null;
    const out = (r.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

// Longest run of whole lines of `text` that fits in `max` UTF-8 bytes. One
// memory is one line, so a cut never lands mid-hit; '' if the first line alone is too big.
const CUT_NOTE = '[Brainlink: cut to fit the hook limit; call get_started or search for the rest]';

// Whole lines of `text` within `max` UTF-8 bytes. A cut ends with `note` so
// the model knows something (possibly rules) was dropped.
export function capBytes(text, max, note = CUT_NOTE) {
  if (Buffer.byteLength(text) <= max) return text;
  const budget = max - Buffer.byteLength(note) - 1;
  const out = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const add = Buffer.byteLength(line) + (out.length ? 1 : 0);
    if (used + add > budget) break;
    out.push(line);
    used += add;
  }
  return out.length ? `${out.join('\n')}\n${note}` : '';
}

// A cut that lands in the rules ends with a note naming each binding rule it
// dropped, so the session knows it is missing rules, and which. A
// bigger note leaves less room and can cut more rules, so it is redone
// until the list holds still; the list only grows, so this ends.
export function capNamingRules(text, raw, domain) {
  let rules = [];
  try {
    const { workingDomain, you } = JSON.parse(raw);
    rules = [...(workingDomain?.rules ?? []), ...(you?.rules ?? [])].filter((r) => typeof r?.content === 'string');
  } catch {}
  let out = capBytes(text, SESSION_CAP_BYTES);
  let note;
  for (;;) {
    const cut = rules.filter((r) => !out.includes(JSON.stringify(r.content))).map((r) => r.slug);
    const next = `[Brainlink: cut to fit the hook limit, which dropped ${cut.length} binding rules: ${cut.join(', ')}. Call get_started({ domain: '${domain}' }) or run \`brainlink get_started --domain ${domain}\`, and follow them before acting]`;
    if (!cut.length || next === note) return out;
    note = next;
    out = capBytes(text, SESSION_CAP_BYTES, note);
  }
}

export function emit(eventName, text, max) {
  const additionalContext = text && capBytes(text, max);
  if (!additionalContext) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }),
  );
}

// BRAINLINK_DOMAIN, else the first line of the nearest `.brainlink` file at or above cwd.
export function findDomain(cwd) {
  const ok = (s) => (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s || '') ? s : null);
  const env = ok((process.env.BRAINLINK_DOMAIN || '').trim());
  if (env) return env;
  let dir = cwd || process.cwd();
  for (let i = 0; i < 40; i++) {
    const f = join(dir, '.brainlink');
    if (existsSync(f)) {
      try {
        return ok(readFileSync(f, 'utf8').split('\n')[0].trim());
      } catch {
        return null;
      }
    }
    // Stop at the repo root or the home folder: a .brainlink above them is
    // not this project's choice.
    if (existsSync(join(dir, '.git')) || dir === homedir()) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// The `items` of a search result: [{ slug, preview, tags, ... }]. Non-JSON gives [].
export function parseItems(raw) {
  try {
    const items = JSON.parse(raw)?.items;
    return Array.isArray(items) ? items.filter((h) => h && typeof h === 'object') : [];
  } catch {
    return [];
  }
}

export function hitLine(h) {
  const text = String(h.preview ?? '').replace(/\s+/g, ' ').trim();
  return text ? `- ${h.slug ?? ''}: ${text}` : '';
}

// Does `tool` match `pattern`, where `*` matches any run of characters? Plain
// string ops: no RegExp is ever built from memory data.
export function matchTool(pattern, tool) {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === tool;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!tool.startsWith(first) || !tool.endsWith(last)) return false;
  let pos = first.length;
  const end = tool.length - last.length;
  if (pos > end) return false;
  for (const mid of parts.slice(1, -1)) {
    const i = tool.indexOf(mid, pos);
    if (i === -1 || i + mid.length > end) return false;
    pos = i + mid.length;
  }
  return true;
}

// Shipped work: commit, push, merge, PR or issue writes. Shell commands count
// only in command position: the start of any line, or after ; & | or an
// opening paren. A mention mid-line (a quoted string, an echo) is not a
// command; a heredoc line that starts with one is.
const AT_CMD = '(?:^|[;&|(\\n])\\s*(?:\\w+=\\S*\\s+)*';
const WORK_CMD = new RegExp(
  `${AT_CMD}(git\\s+(?:-[Cc]\\s+\\S+\\s+)*(commit|push|merge)|gh\\s+(pr\\s+(create|merge)|issue\\s+(create|close)))\\b`,
);
const MERGE_CMD = new RegExp(`${AT_CMD}gh\\s+pr\\s+merge\\b`);

export const isWork = (cmd) => WORK_CMD.test(cmd);
export const isMerge = (cmd) => MERGE_CMD.test(cmd);

// An MCP call that changes something elsewhere: the FIRST verb in the tool's
// own name (after the server prefix, split on _ - .) decides, so get_post and
// apps-get-deployment-status read while apps-update, update-many and
// admin_reschedule_youtube_video write. Brainlink's own tools never count, nor
// does browser or auth plumbing (tabs_create_mcp, complete_authentication):
// a false nudge would spend the quiet window a real write needs.
const READ_VERBS = new Set(
  'get list search read fetch find query count show explain describe aggregate export lookup check view download look inspect browse'.split(' '),
);
const PLUMBING = new Set(['browser', 'tabs', 'authentication']);
const WRITE_VERBS = new Set(
  ('create update delete remove insert drop schedule reschedule post publish cancel withdraw send dm reply forward ' +
    'apply queue revoke upload import edit move restore archive trash transfer invite share star unstar save unsave ' +
    'add set setup rename finalize complete sync run scrape rescrape copy deploy submit merge push batch mark ' +
    'label pin unpin accept decline purchase').split(' '),
);
export function isMcpMutation(tool) {
  if (!tool.startsWith('mcp__') || tool.includes('brainlink')) return false;
  const words = tool.split(/__|\._/).pop().toLowerCase().split(/[-_.]/);
  if (words.some((w) => PLUMBING.has(w))) return false;
  for (const word of words) {
    if (READ_VERBS.has(word)) return false;
    if (WRITE_VERBS.has(word)) return true;
  }
  return false;
}

export function failOpen(fn) {
  try {
    fn();
  } catch {
    /* fail open: no output */
  }
  process.exit(0);
}
