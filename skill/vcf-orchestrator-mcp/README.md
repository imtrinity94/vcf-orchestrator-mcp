# vcf-orchestrator-mcp skill

A free skill that teaches your AI agent how to work with **VCF Operations Orchestrator 9.x** (vRO, embedded in VCF Automation 9 or standalone) through the open-source [vcf-orchestrator-mcp](https://github.com/imtrinity94/vcf-orchestrator-mcp) MCP server.

With it, your agent knows when to use which tool, writes Orchestrator scripts in ES5 (Rhino), builds actions and workflows in small tested steps, runs dry runs before changing infrastructure, keeps versions bumped, and reports back clearly.

## What you need

- The MCP server: `npm install -g vcf-orchestrator-mcp`, then the one-time `vcf-orchestrator-mcp setup` (see `references/setup.md`)
- An MCP-capable agent: Claude Desktop, Claude Code, Cursor, VS Code with Copilot, and others
- A VCF Automation 9 org with a local admin user, and a service account with the **Orchestrator Administrator** role

## What's inside

| File | Purpose |
|---|---|
| `SKILL.md` | When to use the skill, tool choice, ES5 rules, and the working method |
| `references/setup.md` | Install, setup, client config, token refresh, troubleshooting |
| `references/tools.md` | Every tool with its main parameters |
| `references/workflow-spec.md` | The `vro_save_workflow` spec format with a full example |
| `examples/build-and-test-an-action.md` | A worked build, test and fix example |

## Security

This skill contains instructions only: no scripts, no binaries, no credentials. It doesn't install anything. The MCP server it uses connects only to the VCF Automation host you configure, and the setup never stores your password. The service account's refresh token is kept in `~/.vcf-orchestrator-mcp/tokens.json` on your machine.

The MCP server has full access to Orchestrator (it can create, run and delete content), so start in a lab and keep your agent's tool-approval prompts on.

## Author

Mayank Goyal, [cloudblogger.co.in](https://cloudblogger.co.in). MIT licensed, like the MCP server. Issues and ideas: [GitHub](https://github.com/imtrinity94/vcf-orchestrator-mcp/issues).
