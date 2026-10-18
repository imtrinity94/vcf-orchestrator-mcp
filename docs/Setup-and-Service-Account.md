# Setup and Service Account

The one-time `setup` command creates a **VCF Automation service account** for the MCP server and stores its refresh token on your machine. After that, the server logs in as the service account and keeps its token valid by itself, so you never paste a token or a password into a config file.

## Before you start

Collect these values from your VCF Automation:

| Setting | Example | Where to find it |
|---|---|---|
| VCF Automation FQDN | `auto.vmw.lab` | The VCF Automation appliance. The embedded Orchestrator lives at `https://<fqdn>/vco`. |
| Organization **name** | `vmapps-org` | The last part of the tenant URL: `https://<fqdn>/tenant/<name>`. Not the display name, which can differ. |
| Local user | `admin` | A **local** user of that org with an admin role (for example Organization Owner). SSO-only users: see [below](#sso-only-orgs). |
| Service account name | `Lab-vRO-MCP` | Your choice. It appears under **Access Control > Service Accounts**. |
| Service account roles | `Organization Owner,Orchestrator Administrator` | Must include **Orchestrator Administrator**. Role names differ per org. |

## Run setup

Replace the URL, `<org-name>` and `<local-admin>` with your values from the table above (keep the quotes):

```bash
vcf-orchestrator-mcp setup --url "https://auto.example.lab" --org "<org-name>" --user "<local-admin>" --name "Lab-vRO-MCP" --role "Organization Owner,Orchestrator Administrator" --insecure
```

Setup asks for the password with a masked prompt. The password is used once to log in and is never stored.

### Options

| Option | Required | Meaning |
|---|---|---|
| `--url` | yes | VCF Automation URL, e.g. `https://auto.vmw.lab` |
| `--org` | yes | Organization **name** (from the tenant URL) |
| `--user` | yes* | Local user, typed **without** `@org` |
| `--name` | yes* | Service account display name |
| `--role` | no | Comma-separated role names. Default: the role of the user you log in with. |
| `--insecure` | no | Accept a self-signed certificate. Leave it out for trusted certificates. |
| `--password` | no | Skip the prompt (useful for scripting; it ends up in your shell history). `VRO_PASSWORD` works too. |
| `--client-id` | no | Use an existing service account created in the UI instead of `--user`/`--name`. See [SSO-only orgs](#sso-only-orgs). |

\* Not needed with `--client-id`.

### A successful run

```
Password for admin@vmapps-org: ********************
1/5 Logged in as admin@vmapps-org (/cloudapi/1.0.0/sessions)
2/5 Service account 'Lab-vRO-MCP' registered (client_id a971c9cb-..., role Organization Owner, Orchestrator Administrator)
3/5 Device authorization requested (user code T5RW-SJQ7)
4/5 Service account granted
5/5 Tokens issued (access token valid 3600s, refresh token stored)
Check: VCF Automation IaaS API -> HTTP 403; Orchestrator /vco/api -> HTTP 200

Saved to C:\Users\you\.vcf-orchestrator-mcp\tokens.json

MCP client config (e.g. claude_desktop_config.json) - no token or password needed.
Merge it into your existing "mcpServers" if you already have other servers:

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

The check that matters is **`Orchestrator /vco/api -> HTTP 200`**: Orchestrator accepts the service account's token. The IaaS API check can return 403 without affecting the Orchestrator MCP.

Copy the printed config into your client: [Client Configuration](Client-Configuration.md).

## What setup does

Setup runs the VCF Automation 9 service-account flow described in [End-to-end VCF Automation token generation via REST APIs](https://cloudblogger.co.in/2026/05/29/end-to-end-vcf-automation-token-generation-via-rest-apis/), in five calls:

1. **Session login** as `user@org` with `POST /cloudapi/1.0.0/sessions` (falls back to `/tm/cloudapi/1.0.0/sessions`). This is the only step that uses the password. It stops at the first 401, so a typo costs one failed login, not several.
2. **Register a service account** with `POST /oauth/tenant/{org}/register`, using your name and roles.
3. **Device authorization** with `POST /oauth/tenant/{org}/device_authorization`, which returns a device code and a user code.
4. **Grant** the user code as the logged-in admin, with `POST /tm/cloudapi/1.0.0/deviceLookup/grant`.
5. **Get the tokens** with `POST /tm/oauth/tenant/{org}/token` and `grant_type=urn:ietf:params:oauth:grant-type:device_code`.

The refresh token and the service account's client ID are saved to `~/.vcf-orchestrator-mcp/tokens.json` (on Windows `C:\Users\<you>\.vcf-orchestrator-mcp\tokens.json`). How it stays valid: [Token Refresh](Token-Refresh.md).

## Roles

- The service account needs **Orchestrator Administrator**. Without it, Orchestrator treats the account as a plain user: it connects, but sees no workflows or actions, not even the library.
- Role names differ per org. In some orgs the admin role is **Organization Owner**, not Organization Administrator. If setup reports *"Unable to find the following role(s)"*, use the names from **Access Control > Roles**.
- You can add roles later on the service account in **Access Control > Service Accounts**. Restart your MCP client afterwards so the server gets a token with the new roles.

## SSO-only orgs

Users who sign in through SSO or an external identity provider can't log in with a password over the API. In that case:

1. In the tenant portal, create the service account under **Access Control > Service Accounts > New**, with the roles above, and copy its **client ID**.
2. Run:
   ```bash
   vcf-orchestrator-mcp setup --url "https://auto.example.lab" --org "<org-name>" --client-id "<client-id>" --insecure
   ```
3. Setup prints a user code and waits up to 10 minutes. Grant the code under **Review Access Requests**, and setup finishes by itself.

## Run setup again when

- the service account was deleted, disabled or revoked;
- the token file was deleted or copied to another machine;
- the server reports *"refresh token was already used or revoked"*.

Setup overwrites the saved token for that host and org. Delete the old service account in the UI first if you reuse its name.

## Next step

[Client Configuration](Client-Configuration.md)
