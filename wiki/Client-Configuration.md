# Client Configuration

After [[setup|Setup-and-Service-Account]], add the server to your MCP client. The config holds only the URL, auth mode, org and certificate setting. **No password or token goes in it.**

Replace `https://auto.vmw.lab` and `vmapps-org` with your own values, and leave out `VRO_INSECURE` if your certificates are trusted.

## Claude Desktop

Open **Settings > Developer > Edit Config** (`claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "vcf-orchestrator": {
      "command": "vcf-orchestrator-mcp",
      "env": {
        "VRO_URL": "https://auto.vmw.lab",
        "VRO_AUTH_MODE": "api-token",
        "VRO_ORG": "vmapps-org",
        "VRO_INSECURE": "true"
      }
    }
  }
}
```

If you already have other servers, add the `vcf-orchestrator` entry inside your existing `mcpServers` instead of adding a second one.

**Fully quit Claude Desktop** (also from the system tray on Windows, or the menu bar on macOS) and open it again. Closing the window is not enough.

### If the server doesn't start on Windows

If Claude Desktop can't find the `vcf-orchestrator-mcp` command, point it at Node and the installed script instead:

```json
"vcf-orchestrator": {
  "command": "node",
  "args": ["C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\vcf-orchestrator-mcp\\dist\\cli.js"],
  "env": { "VRO_URL": "https://auto.vmw.lab", "VRO_AUTH_MODE": "api-token", "VRO_ORG": "vmapps-org", "VRO_INSECURE": "true" }
}
```

`npm root -g` shows the folder that contains `node_modules` on your machine. For a source install, use `<path>\vcf-orchestrator-mcp\dist\cli.js`.

## Claude Code

```bash
claude mcp add vcf-orchestrator --scope user \
  -e VRO_URL=https://auto.vmw.lab \
  -e VRO_AUTH_MODE=api-token \
  -e VRO_ORG=vmapps-org \
  -e VRO_INSECURE=true \
  -- vcf-orchestrator-mcp
```

Check it with `claude mcp list`, or `/mcp` inside a session.

## Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "vcf-orchestrator": {
      "command": "vcf-orchestrator-mcp",
      "env": {
        "VRO_URL": "https://auto.vmw.lab",
        "VRO_AUTH_MODE": "api-token",
        "VRO_ORG": "vmapps-org",
        "VRO_INSECURE": "true"
      }
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

Add to `.vscode/mcp.json` in your workspace. Note that VS Code uses `servers`, not `mcpServers`:

```json
{
  "servers": {
    "vcf-orchestrator": {
      "type": "stdio",
      "command": "vcf-orchestrator-mcp",
      "env": {
        "VRO_URL": "https://auto.vmw.lab",
        "VRO_AUTH_MODE": "api-token",
        "VRO_ORG": "vmapps-org",
        "VRO_INSECURE": "true"
      }
    }
  }
}
```

## Other clients

Any client that runs local (stdio) MCP servers works: start the command `vcf-orchestrator-mcp` with the four environment variables above. All settings are listed in [[Configuration Reference|Configuration-Reference]].

## Test it

Ask your assistant:

> Run vro_server_info and tell me which Orchestrator I'm connected to.

You should see the Orchestrator version, `authMode: api-token` and when the current access token expires. If it reports `LOGIN FAILED`, see [[Troubleshooting]].

## One machine, one token file

Each machine needs its own setup. Don't copy `tokens.json` between machines: the refresh token rotates, so the first machine to refresh breaks the other one. Clients on the same machine read the same file, so they share the latest token. Running two clients with the server at the same moment can, rarely, race on a refresh; if that happens you'll see `invalid_grant`, and running setup again fixes it.
