# Brainlink plugin for Claude Code and Codex

Brainlink is one shared memory for your AI clients and teammates. This plugin connects Claude Code and Codex to it.

| | Claude Code | Codex |
|---|---|---|
| Brainlink MCP tools (OAuth sign-in) | yes | yes |
| `brainlink` skill: call `get_started` first, follow workspace skills | yes | yes |
| Hook: nudge to save after shipped work | yes | not yet (Codex plugin hooks are unverified) |
| Hooks: rules at session start, subagent rules, tool triggers | with the `brainlink` CLI (not published yet); without it, one line asking the agent to call `get_started` | not yet |

## Install

Claude Code:

```bash
claude plugin marketplace add ugglr/brainlink-plugins && claude plugin install brainlink@brainlink
```

Then run `/mcp`, select `plugin:brainlink:brainlink` and sign in to Brainlink in the browser.

Codex:

```bash
codex plugin marketplace add ugglr/brainlink-plugins && codex plugin add brainlink@brainlink
codex mcp login brainlink
```

Already connected to Brainlink another way (the claude.ai connector in Claude Code, the ChatGPT connector in Codex)? The plugin's server has the same URL, and in Claude Code it takes the connector's place, so sign in to it once with `/mcp`. To keep your connector instead, drop just the plugin's server and keep its hooks and skill:

- Claude Code, in `~/.claude/settings.json`: `"deniedMcpServers": [{ "serverName": "plugin:brainlink:brainlink" }]` (by name: a `serverUrl` entry would block the connector too).
- Codex, in `~/.codex/config.toml`: a `[mcp_servers.brainlink]` table with the same `url` and `enabled = false`.

No key is stored in the plugin or your config. Tell it which domain a project belongs to with a `.brainlink` file holding the domain slug at the repo root, or `BRAINLINK_DOMAIN`. To set it, run `echo your-domain > .brainlink` in the repo root.

The `brainlink` CLI is not published yet. Until it is, `SessionStart` adds one line asking the agent to call `get_started` itself, and the two hooks that read what the CLI fetched (`SubagentStart` rules, `PreToolUse` triggers) do nothing.

## What it ships

- `.mcp.json`: remote HTTP MCP server at the hosted Brainlink `/mcp/oauth` endpoint.
- `skills/brainlink/SKILL.md`: tells Claude to call `get_started({ domain })` first and follow workspace skills (`/brainlink:brainlink`).
- `hooks/hooks.json` and `scripts/`: hooks that deliver memory through the local `brainlink` CLI when it is installed and logged in. The CLI holds the login; nothing secret is stored in the plugin. Every hook fails open (exit 0) when the CLI is missing, not logged in, slow or failing, so it never blocks a session or a tool call.
  - `SessionStart`: runs `get_started` for the project's domain and adds it as context; without a working CLI it adds one line asking the agent to call `get_started` itself. The domain is `BRAINLINK_DOMAIN`, else the first line of the nearest `.brainlink` file at or above the working directory, up to the repo root or your home folder; with neither, it adds one conditional line: call `get_started` without a domain for the map, propose a slug, and write it to `.brainlink` only after the user confirms. An empty `.brainlink` means no domain and silences it; a non-slug one gets a one-line warning. It keeps `fromSubagents` (what subagents saved under a `brief` handoff) ahead of the cut. A cloned repo's `.brainlink` chooses which domain loads, so treat that file like any other repo config.
  - `SubagentStart`: SessionStart does not reach subagents, so each one gets the binding rules SessionStart cached for the session (`${CLAUDE_PLUGIN_DATA}/rules-<session>.json`, mode 0600, deleted after 7 days), plus a line asking it to save durable findings, or report them when it has no Brainlink tools. It only reads that file: no network call. Agents whose type starts with `bench-` get nothing, so benchmark arms stay blind.
  - `PreToolUse`: prints memories tagged `when:<ToolName>` before a matching tool call, capped at 1 KB.
  - `PostToolUse`: a nudge, never a block. Right after something durable may have happened (a commit, push, merge, or PR or issue write; an MCP call whose name's first verb writes, such as `create`, `schedule`, `apps-update` or `update-many`, while `get_post` reads; the user answering an `AskUserQuestion`), it adds one line asking Claude to save what the next session needs; whether anything is worth saving is Claude's call. It stays quiet for 30 minutes after a nudge (`${CLAUDE_PLUGIN_DATA}/nudge-<session>.json`), except that a `gh pr merge` always gets one. Brainlink's own tools and subagents never get one. It runs for `Bash`, `AskUserQuestion` and MCP tools only, and makes no network call.

### Tool triggers: the `when:` tag convention

No schema change: tag a memory `when:Bash` (or `when:mcp__github__*`; `*` is a wildcard) and it is shown before every matching tool call. `SessionStart` fetches these memories once per session into `${CLAUDE_PLUGIN_DATA}/triggers-<session>.json` (up to 20 distinct `when:` tags found via `list_tags`, which has no prefix filter and returns at most its 500 most-used tags, then one `search` for the 50 newest of those memories; 10 per tag; file mode 0600, files older than 7 days are deleted), and `PreToolUse` only reads that file, so it makes no network call. A memory saved mid-session appears from the next session. Argument matching is not supported, only the tool name.

Hook contract: [hooks reference](https://code.claude.com/docs/en/hooks) (`hookSpecificOutput.additionalContext`), [plugin hooks and `CLAUDE_PLUGIN_DATA`](https://code.claude.com/docs/en/plugins-reference). Tests: `node --test test/hooks.test.mjs` from the plugin folder (stub `brainlink` on PATH).

Prefer a key instead of OAuth? Skip the plugin's server and use the raw command from Brainlink's Connect page (`claude mcp add --transport http ... --header 'Authorization: Bearer YOUR_KEY'`).

License: MIT.

Validate locally: `claude plugin validate ./plugins/brainlink` and `claude plugin validate .`
