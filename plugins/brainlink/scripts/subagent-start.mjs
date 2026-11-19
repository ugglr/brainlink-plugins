// SubagentStart: no SessionStart reaches a subagent, so each gets the binding
// rules SessionStart cached for this session. A file read only: no network
// call per subagent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, emit, capNamingRules, failOpen, SESSION_CAP_BYTES } from './lib.mjs';

failOpen(() => {
  const input = readInput();
  // Benchmark arms (agent types starting `bench-`) must stay blind to the brain.
  if (String(input.agent_type ?? '').startsWith('bench-')) return;
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir || !/^[\w-]+$/.test(input.session_id ?? '')) return;
  const raw = readFileSync(join(dir, `rules-${input.session_id}.json`), 'utf8');
  const { domain, workingDomain, you } = JSON.parse(raw);
  const rules = JSON.stringify({ 'workingDomain.rules': workingDomain.rules, 'you.rules': you.rules }, null, 1);
  const text = `Brainlink (${domain}): binding rules for this subagent; where the two sets conflict, the domain's win. Durable findings (a decision, a measurement, a blocker): save them if you have Brainlink tools, else include them in your report.\n${rules}`;
  emit('SubagentStart', capNamingRules(text, raw, domain), SESSION_CAP_BYTES);
});
