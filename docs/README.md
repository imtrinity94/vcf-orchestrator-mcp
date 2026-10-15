# vcf-orchestrator-mcp

**vcf-orchestrator-mcp** is an open-source MCP server that lets an AI assistant work directly with **VCF Operations Orchestrator (vRO) 9.x**: find and read workflows, create and update actions and workflows, run them, follow executions and read the logs, all through the Orchestrator REST API.

It works with the Orchestrator **embedded in VCF Automation 9** and with a **standalone (external)** VCF Operations Orchestrator 9.x. It has been verified end to end on VCF Automation 9.1.1 with the embedded Orchestrator.

> **A note on the AI:** these pages say "Claude" for the AI assistant, but vcf-orchestrator-mcp is a standard MCP server. It works with any MCP-capable client: Claude Desktop, Claude Code, Cursor, VS Code with GitHub Copilot, and others.

## Start here

1. [Installation](Installation.md): install the package.
2. [Setup and Service Account](Setup-and-Service-Account.md): the one-time setup that creates a VCF Automation service account.
3. [Client Configuration](Client-Configuration.md): add the server to Claude Desktop, Claude Code, Cursor or VS Code.
4. Ask your assistant: *"Run vro_server_info and tell me which Orchestrator I'm connected to."*

Prefer to watch? The [blog post](https://cloudblogger.co.in/2026/10/14/vcf-orchestrator-mcp-claude-for-vcf-operations-orchestrator/) has a setup and demo video.

## All pages

| Page | What's in it |
|---|---|
| [Installation](Installation.md) | Requirements and install options (npm, from source) |
| [Setup and Service Account](Setup-and-Service-Account.md) | The `setup` command, its options, and what it does |
| [Client Configuration](Client-Configuration.md) | Config for Claude Desktop, Claude Code, Cursor, VS Code |
| [Tools Reference](Tools-Reference.md) | Every tool and its main parameters |
| [Token Refresh](Token-Refresh.md) | How the login stays valid without pasting tokens |
| [Configuration Reference](Configuration-Reference.md) | Every `VRO_*` environment variable and all auth modes |
| [Examples and Prompts](Examples-and-Prompts.md) | Prompts to try and worked walkthroughs |
| [Troubleshooting](Troubleshooting.md) | Error messages and how to fix them |
| [FAQ](FAQ.md) | Common questions |

## Links

- npm: [vcf-orchestrator-mcp](https://www.npmjs.com/package/vcf-orchestrator-mcp)
- Blog: [vcf-orchestrator-mcp: Let Claude build, run and debug your Orchestrator workflows](https://cloudblogger.co.in/2026/10/14/vcf-orchestrator-mcp-claude-for-vcf-operations-orchestrator/)
- Background: [End-to-end VCF Automation token generation via REST APIs](https://cloudblogger.co.in/2026/05/29/end-to-end-vcf-automation-token-generation-via-rest-apis/)
- Issues and ideas: [GitHub Issues](https://github.com/imtrinity94/vcf-orchestrator-mcp/issues)
