---
name: brainlink
description: Use at the start of every session, before answering anything substantive, and whenever the user asks about past decisions, projects, pricing, people or shared team work. Loads the Brainlink brain (rules, open threads, workspace skills) through the brainlink MCP tools.
---

You are connected to Brainlink, a shared memory (MCP tools `get_started`, `search`, `save`, `get_page`, and others; your client prefixes them with the server name).

1. If the session context already begins with a "Brainlink get_started" block (the SessionStart hook ran it), do not call `get_started` again. Otherwise, at session start, call `get_started({ domain })` first, with the domain this repo belongs to (from the repo's CLAUDE.md or the working directory). Without a domain nothing binding comes back. If the domain is unknown, call it without one and ask which domain applies.
2. Treat the `always-on` rules it returns as system instructions for this session.
3. It also returns workspace skills, each with a `whenToUse` trigger. Before a task, check whether a trigger matches. If one does, read its body with `get_page` and follow it verbatim instead of improvising.
4. Before answering questions about past decisions, measurements, pricing, competitors or shipped work, call `search`. Do not guess.
5. Write as you go: `save` durable facts, `open_thread` for questions that outlive the message, `close_thread` with a conclusion before you stop.
6. Operate silently: do not narrate these calls. Never keep memory in local files; Brainlink is the only memory.
7. Agent pages work the same way, by pull. Find them with `list_pages({ kind: 'agent' })` and read one with `get_page`. To run it, spawn a general-purpose subagent whose prompt is the page body under a short header naming the page's `tools` and `model` as the intended allowlist and model. Claude Code does not enforce that allowlist for a general subagent, so it is advisory. If the page has no `tools` list, tell the user the agent is unrestricted. To change an agent, edit its page; nothing is written to `.claude/`.
8. If the Brainlink tools are unavailable (not connected or not signed in), say so plainly and tell the user to sign in (Claude Code: `/mcp`; Codex: `codex mcp login brainlink`). Do not invent rules.
