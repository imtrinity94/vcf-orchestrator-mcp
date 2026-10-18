# Setup and troubleshooting

The user runs these steps on their own machine. Guide them; never ask for their password or tokens in the chat.

## Requirements

- Node.js 18.17 or newer
- An MCP-capable client (Claude Desktop, Claude Code, Cursor, VS Code with Copilot, ...)
- A VCF Automation 9 organization with a **local** user that has an admin role in that org

## 1. Install

```
npm install -g vcf-orchestrator-mcp
```

## 2. One-time setup

```
vcf-orchestrator-mcp setup --url "https://auto.example.lab" --org "<org-name>" --user "<local-admin>" --name "Lab-vRO-MCP" --role "Organization Owner,Orchestrator Administrator" --insecure
```

- `--org` is the organization **name**, the last part of `https://<vcfa-fqdn>/tenant/<name>`, not its display name.
- `--user` is typed without `@org`.
- `--name` is the service account's display name in VCF Automation (Access Control > Service Accounts).
- `--role` takes comma-separated role names. It must include **Orchestrator Administrator**, otherwise the account sees no workflows. Role names differ per org; without `--role` the account gets the logged-in user's role.
- `--insecure` accepts a self-signed certificate. Leave it out for trusted certificates.

The password is asked for with a masked prompt and is never stored. Setup creates a service account, grants it, and saves its refresh token to `~/.vcf-orchestrator-mcp/tokens.json`. It ends by checking Orchestrator's `/vco/api`, which must return HTTP 200, and prints the client config.

**SSO-only orgs:** create the service account in the UI, then run `vcf-orchestrator-mcp setup --url ... --org ... --client-id <its client ID>`. Setup prints a code; grant it under Review Access Requests and setup finishes by itself.

## 3. Client config

Add this to the client's MCP config (for Claude Desktop: Settings > Developer > Edit Config), inside the existing `mcpServers` if there is one. No password or token goes in it:

```json
{
  "mcpServers": {
    "vcf-orchestrator": {
      "command": "vcf-orchestrator-mcp",
      "env": {
        "VRO_URL": "https://<vcfa-fqdn>",
        "VRO_AUTH_MODE": "api-token",
        "VRO_ORG": "<org name>",
        "VRO_INSECURE": "true"
      }
    }
  }
}
```

Fully restart the client afterwards.

## How tokens stay valid

Access tokens last about an hour. Before each call the server checks the token; if under a minute is left it refreshes with the stored refresh token. VCF Automation rotates the refresh token on each refresh, and the server saves the new one immediately. One token file belongs to one machine: copying it to a second machine breaks the chain for one of them.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Setup: login HTTP 401 | Wrong password, the user isn't a local user of that org, the org name is the display name, or the account is locked after failed attempts. Check the tenant URL for the org name and unlock the user if needed. |
| Setup: "Unable to find the following role(s)" | That role name doesn't exist in this org. Pass the org's real role names with `--role`, e.g. "Organization Owner". |
| Setup check: Orchestrator HTTP 401/403 | The service account lacks Orchestrator rights. Add **Orchestrator Administrator** to it in the UI and restart the client. |
| Connected, but no workflows or actions found | Same cause: the account is a plain Orchestrator user (`GET /users` returns `role: USER`). Add Orchestrator Administrator and restart the client. |
| New roles not visible yet | The current access token was issued before the change. Restart the client to get a new one. |
| "refresh token was already used or revoked" / invalid_grant | The chain is broken (account revoked, token file deleted or copied to another machine). Run setup again. |
| Certificate errors | Self-signed lab certificate: set `VRO_INSECURE` to `"true"`, or use `--insecure` for setup. |
| Connection timeouts | The machine can't reach the VCF Automation host (VPN, DNS, firewall). Check the URL in a browser from the same machine. |
