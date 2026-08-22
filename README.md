# Website

## Obsidian MCP server

This repo ships a project-scoped MCP configuration in [`.mcp.json`](.mcp.json) that
starts [`obsidian-mcp`](https://www.npmjs.com/package/obsidian-mcp) via `npx`, giving
Claude Code read/write access to an Obsidian vault.

The vault path is not hardcoded — it is read from the `OBSIDIAN_VAULT_PATH`
environment variable so each person can point at their own vault:

```bash
export OBSIDIAN_VAULT_PATH="/absolute/path/to/your/obsidian/vault"
```

Add that line to your shell profile (`~/.zshrc`, `~/.bashrc`) so it is set for every
session. The path must be absolute — `~` is not expanded.

On the next `claude` start in this directory, Claude Code will prompt you to approve
the project's MCP servers. Approve it once, then verify with:

```
/mcp
```

The `obsidian` server should be listed as connected. Node.js (which provides `npx`)
must be installed.
