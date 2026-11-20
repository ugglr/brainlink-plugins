// PostToolUse: a nudge, never a block. Right after something durable may have
// happened (a commit, push, merge, PR or issue write; an MCP call that changes
// something elsewhere; the user answering a question), add one line asking
// Claude to save what the next session needs; whether anything is worth saving
// is Claude's call. Quiet for QUIET_MS after a nudge, so it asks at most twice
// an hour; a PR merge always gets one. Subagents get none: their findings come
// back in their report. No network call.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, domainState, emit, isWork, isMerge, isMcpMutation, failOpen, CAP_BYTES } from './lib.mjs';

const QUIET_MS = 30 * 60_000;

failOpen(() => {
  const input = readInput();
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const { session_id: sid, tool_name: tool = '' } = input;
  if (!dataDir || !sid || !/^[\w-]+$/.test(sid) || input.agent_id) return;
  const domain = domainState(input.cwd).domain;
  if (!domain) return;
  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const what = isWork(cmd)
    ? 'that shipped work'
    : tool === 'AskUserQuestion'
      ? 'the user just answered a question'
      : isMcpMutation(tool)
        ? `that changed something outside this session (${tool})`
        : null;
  if (!what) return;
  const file = join(dataDir, `nudge-${sid}.json`);
  let at = 0;
  try {
    at = Number(JSON.parse(readFileSync(file, 'utf8')).at) || 0;
  } catch {
    /* no nudge yet this session */
  }
  const now = Date.now();
  if (!isMerge(cmd) && now - at < QUIET_MS) return;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ at: now }), { mode: 0o600 });
  emit(
    'PostToolUse',
    `Brainlink (${domain}): ${what}. If it holds something the next session needs (a decision, a measurement, the commit, a blocker, project state), save it; your call.`,
    CAP_BYTES,
  );
});
