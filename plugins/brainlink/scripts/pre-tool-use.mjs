// PreToolUse: print memories tagged `when:<pattern>` whose pattern matches the
// tool name (exact, or `*` wildcard), from the cache SessionStart wrote.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, emit, matchTool, failOpen, CAP_BYTES } from './lib.mjs';

failOpen(() => {
  const input = readInput();
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const { session_id: sid, tool_name: tool } = input;
  if (!dataDir || !tool || !sid || !/^[\w-]+$/.test(sid)) return;
  const triggers = JSON.parse(readFileSync(join(dataDir, `triggers-${sid}.json`), 'utf8'));
  const lines = Object.entries(triggers)
    .filter(([pattern]) => matchTool(pattern, tool))
    .flatMap(([, ls]) => ls);
  if (lines.length) emit('PreToolUse', `Brainlink memories for ${tool}:\n${lines.join('\n')}`, CAP_BYTES);
});
