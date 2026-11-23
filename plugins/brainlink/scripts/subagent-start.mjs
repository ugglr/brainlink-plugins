// SubagentStart: no SessionStart reaches a subagent, so each gets the binding
// rules SessionStart cached for this session. A file read only: no network
// call per subagent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, emit, fitView, failOpen, SESSION_CAP_BYTES } from './lib.mjs';

failOpen(() => {
  const input = readInput();
  // Benchmark arms (agent types starting `bench-`) must stay blind to the brain.
  if (String(input.agent_type ?? '').startsWith('bench-')) return;
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir || !/^[\w-]+$/.test(input.session_id ?? '')) return;
  const raw = readFileSync(join(dir, `rules-${input.session_id}.json`), 'utf8');
  const { domain, ...rules } = JSON.parse(raw);
  const header = `Brainlink (${domain}): binding rules for this subagent; where the two sets conflict, the domain's win. Durable findings (a decision, a measurement, a blocker): save them if you have Brainlink tools, else include them in your report.`;
  // A subagent follows rules, never edits them: a plain line each, no slug.
  const line = (r) => `- ${r.content}${r.basis ? ` (basis: ${r.basis})` : ''}`;
  emit('SubagentStart', fitView(rules, domain, header, SESSION_CAP_BYTES, line), SESSION_CAP_BYTES);
});
