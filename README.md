# Brainlink plugins

Brainlink is one shared memory for your AI clients and teammates. This repo is its plugin marketplace for Claude Code and Codex. Codex gets the MCP server and skill; the hooks are Claude Code only for now.

```bash
# Claude Code
claude plugin marketplace add ugglr/brainlink-plugins && claude plugin install brainlink@brainlink

# Codex
codex plugin marketplace add ugglr/brainlink-plugins && codex plugin add brainlink@brainlink
codex mcp login brainlink
```

What the plugin does and how to sign in: [plugins/brainlink/README.md](plugins/brainlink/README.md).

License: MIT.
