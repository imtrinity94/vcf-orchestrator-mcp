# Installation

## Requirements

- **Node.js 18.17 or newer** on the machine that runs your AI client. Check with `node --version`.
- An **MCP-capable client**: Claude Desktop, Claude Code, Cursor, VS Code with GitHub Copilot, or similar.
- Network access from that machine to your **VCF Automation** host (or standalone Orchestrator) over HTTPS.
- For the recommended login: a VCF Automation 9 organization with a **local** user that has an admin role in that org. See [Setup and Service Account](Setup-and-Service-Account.md).

## Install from npm (recommended)

```bash
npm install -g vcf-orchestrator-mcp
```

This gives you the `vcf-orchestrator-mcp` command, used both for the one-time `setup` and to start the MCP server.

Check it:

```bash
vcf-orchestrator-mcp setup --help
```

A global install starts much faster than `npx`, which matters because MCP clients give a server only a few seconds to start.

## Update

```bash
npm install -g vcf-orchestrator-mcp@latest
```

Then fully restart your MCP client. Your service account and saved token stay as they are; no new setup is needed.

## Run from source

```bash
git clone https://github.com/imtrinity94/vcf-orchestrator-mcp.git
cd vcf-orchestrator-mcp
npm install
```

`npm install` also builds the project into `dist/`. Then:

- run setup with `node dist/cli.js setup ...`
- point your client at `node` with the argument `<path>/vcf-orchestrator-mcp/dist/cli.js` (see [Client Configuration](Client-Configuration.md))

To update a source install, run `git pull` and `npm install` again.

## Next step

[Setup and Service Account](Setup-and-Service-Account.md)
