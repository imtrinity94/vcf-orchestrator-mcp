# Troubleshooting

Start with `vro_server_info`. It shows the auth mode, the token expiry, and on failure the error plus a probe of every login endpoint.

## Setup

| Symptom | Cause and fix |
|---|---|
| `Login failed ... HTTP 401` | Wrong password; the user isn't a **local** user of that org; `--org` is the display name instead of the name; or the account is locked. Check the org name in the tenant URL, check the user under **Access Control > Users**, and unlock it if needed. Setup stops at the first 401 to avoid locking the account. |
| The account gets locked | Repeated failed logins. Unlock the user in the UI, then run setup once with the correct password. |
| No password prompt appears, or the command just sits there | An old version is installed. `npm install -g vcf-orchestrator-mcp@latest`, then try again. |
| `Unable to find the following role(s) in org ...` | That role name doesn't exist in this org. Use the names from **Access Control > Roles**, e.g. `--role "Organization Owner,Orchestrator Administrator"`. |
| `Check: ... Orchestrator /vco/api -> HTTP 401/403` | The service account has no Orchestrator rights. Add **Orchestrator Administrator** to it and restart your client. |
| `Check: VCF Automation IaaS API -> HTTP 403` | Expected with some roles. It doesn't affect the Orchestrator MCP. |
| Certificate errors (`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) | Self-signed lab certificate. Add `--insecure` to setup and `"VRO_INSECURE": "true"` to the client config. |
| SSO-only org, no local user | Use the `--client-id` flow: [Setup and Service Account](Setup-and-Service-Account.md#sso-only-orgs). |
| `fatal: not a git repository` while updating a source install | You're not in the project folder. `cd` into it first. |
| `git pull` refuses because `package-lock.json` changed | npm rewrote it. `git checkout -- package-lock.json`, then `git pull`. |

## Connecting

| Symptom | Cause and fix |
|---|---|
| The tools don't appear in the client | The client wasn't fully restarted, the JSON has a syntax error, or the command isn't found. Quit the client completely (system tray / menu bar too). On Windows, use the `node` + `cli.js` form from [Client Configuration](Client-Configuration.md). |
| The server times out on start | Use a global install instead of `npx`, so it starts quickly. |
| `LOGIN FAILED` / `No refresh token for <org>` | Setup hasn't run on this machine, or `VRO_ORG` / `VRO_URL` don't match what you used in setup. The token is stored per host and org. |
| `The refresh token was already used or revoked` / `invalid_grant` | The token chain is broken: service account revoked, token file deleted, or the file copied to another machine. Run setup again. |
| `VRO_TOKEN expired at ...` | You're in `token` mode with a pasted token. Switch to `api-token` and run setup. |
| `UND_ERR_CONNECT_TIMEOUT` / cannot reach host | The machine can't reach VCF Automation: VPN, DNS or firewall. Open the URL in a browser on the same machine. Often a short network drop; try again. |

## Using it

| Symptom | Cause and fix |
|---|---|
| Connected, but no workflows or actions found, not even the library | The service account is a plain Orchestrator user (`GET /users` shows `role: USER`). Add **Orchestrator Administrator** in **Access Control > Service Accounts**, then restart the client. |
| New roles not taking effect | The current access token predates the change. Restart the client. |
| A workflow run fails with `Cannot find function ...` on a `ResourceElement` input | Fixed in 0.4.1: built-in inventory types are sent as SDK objects. Update to the latest version. |
| An onboarding plan fails with a duplicate name | VCF Automation deployment names must be unique. Use a deployment name prefix, or remove the old deployment. |
| `GET /workflows` returns 400 with `queryCount` | Orchestrator 9.1 doesn't accept `queryCount`. Use `maxResult` and `startIndex`. |
| A folder moved to the root after renaming it with `PUT /categories/{id}` | Pass `name`, `type` and `parent-category-id`, otherwise the parent is dropped. |
| An action's version can't be changed from a script | That's an Orchestrator limitation. Use `vro_save_action` or `vro_set_versions`. |
| A script fails with a syntax error on valid-looking JavaScript | Orchestrator runs Rhino (ES5). Replace arrow functions, `let`/`const`, template literals and other ES6+ syntax. |

Still stuck? Open an [issue](https://github.com/imtrinity94/vcf-orchestrator-mcp/issues) with the `vro_server_info` output (remove anything sensitive).
