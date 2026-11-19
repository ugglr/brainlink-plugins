// SessionStart: get_started for the project's domain as additional context, and
// cache the binding rules for SubagentStart and memories tagged `when:<ToolName>`
// for PreToolUse.
import { mkdirSync, writeFileSync, chmodSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, brainlink, emit, capNamingRules, findDomain, parseItems, hitLine, failOpen, SESSION_CAP_BYTES } from './lib.mjs';

const deadline = Date.now() + 15000; // one budget for the whole script, under the 20 s hook timeout
// Each call gets min(its own limit, what is left); null once the budget is gone.
const call = (args, ownMs) => {
  const left = deadline - Date.now();
  return left < 300 ? null : brainlink(args, Math.min(ownMs, left));
};

failOpen(() => {
  const input = readInput();
  const domain = findDomain(input.cwd);
  if (!domain) return;
  const started = call(['get_started', '--domain', domain], 10000);
  if (started) emit('SessionStart', capNamingRules(`Brainlink get_started (${domain}):\n${layout(started)}`, started, domain), SESSION_CAP_BYTES);
  // No CLI, not logged in, or no answer: the agent enters through its own MCP connection.
  else emit('SessionStart', `Brainlink (${domain}): call get_started({ domain: '${domain}' }) before you answer anything substantive, and treat the rules it returns as system instructions. If the Brainlink tools are missing, tell the user to sign in (Claude Code: /mcp; Codex: codex mcp login brainlink).`, SESSION_CAP_BYTES);
  cacheSession(input.session_id, domain, started); // after the emit, so a slow cache never costs get_started
});

function cacheSession(sessionId, domain, started) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir || !sessionId || !/^[\w-]+$/.test(sessionId)) return;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const file = join(dataDir, `triggers-${sessionId}.json`);
  for (const f of readdirSync(dataDir)) {
    const p = join(dataDir, f);
    if (/^(triggers|stop|rules|nudge)-.*\.json$/.test(f) && Date.now() - statSync(p).mtimeMs > 7 * 864e5) rmSync(p, { force: true });
  }
  rmSync(file, { force: true });
  // No SessionStart reaches a subagent; SubagentStart reads its rules here.
  const rulesFile = join(dataDir, `rules-${sessionId}.json`);
  rmSync(rulesFile, { force: true });
  const rules = rulesOnly(started, domain);
  if (rules) writeFileSync(rulesFile, rules, { mode: 0o600 });
  // list_tags is by frequency and has no prefix filter; 500 is its largest limit.
  const tagItems = parseItems(call(['list_tags', '--domain', domain, '--limit', '500'], 3000) ?? '');
  const whens = [...new Set(tagItems.map((t) => t.tag).filter((t) => /^when:[A-Za-z0-9_.*-]+$/.test(t)))].slice(0, 20);
  if (!whens.length) return;
  // One search: --tags is "any of", and each hit lists its own tags.
  const args = ['search', '--domain', domain, '--limit', '50'];
  for (const t of whens) args.push('--tags', t);
  const triggers = {};
  for (const h of parseItems(call(args, 4000) ?? '')) {
    const line = hitLine(h);
    for (const t of h.tags ?? []) {
      if (!line || !whens.includes(t)) continue;
      const list = (triggers[t.slice(5)] ??= []);
      if (list.length < 10) list.push(line);
    }
  }
  if (!Object.keys(triggers).length) return;
  writeFileSync(file, JSON.stringify(triggers), { mode: 0o600 });
}

// get_started is one long JSON line, which a line cut would drop whole. Pretty-print
// it with both binding rule sets first, the domain's (which win on conflict) then the
// user's, so the cut takes the domain's state and the rest before any rule.
// Rules alone past the cap are still cut, and capNamingRules names them.
function layout(raw) {
  try {
    const { you, workingDomain, ...d } = JSON.parse(raw);
    const { rules: userRules, ...userRest } = you ?? {};
    const { rules: domainRules, ...domainRest } = workingDomain ?? {};
    const ordered = {
      guidance: d.guidance,
      'workingDomain.rules': domainRules,
      'you.rules': userRules,
      // Small, and the parent's only report of its subagents' saves: keep it.
      fromSubagents: d.fromSubagents,
      workingDomain: domainRest,
      otherDomains: d.otherDomains,
      skills: d.skills,
      ...d,
      you: userRest,
    };
    return JSON.stringify(ordered, null, 1);
  } catch {
    return raw;
  }
}

function rulesOnly(raw, domain) {
  try {
    const { workingDomain, you } = JSON.parse(raw);
    return JSON.stringify({ domain, workingDomain: { rules: workingDomain?.rules ?? [] }, you: { rules: you?.rules ?? [] } });
  } catch {
    return null;
  }
}
