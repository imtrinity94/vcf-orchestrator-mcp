# Token Refresh

With `VRO_AUTH_MODE=api-token`, the server keeps its own login alive. You don't paste tokens, and restarts or reboots don't require a new setup.

## How it works

1. Before each call to Orchestrator, the server checks its access token. If more than a minute is left, it uses it.
2. If less than a minute is left, or there's no token yet (for example right after a restart), it refreshes first: `POST /oauth/tenant/{org}/token` with `grant_type=refresh_token`, the stored refresh token and the service account's client ID. It falls back to `/tm/oauth/tenant/{org}/token`.
3. VCF Automation returns a new access token, valid for about an hour, and a **new refresh token**. The old refresh token stops working. This is refresh token rotation.
4. The server saves the new refresh token to the token file straight away, with an atomic write so a crash can't leave a half-written file, and only then makes your call.
5. If a call still gets a 401, for example because the service account's roles changed, the server refreshes once and retries that call.

There is **no background timer**. If you don't use the MCP for a few hours, nothing happens in between. The next call refreshes first, which adds a fraction of a second.

## The token file

| | |
|---|---|
| Location | `~/.vcf-orchestrator-mcp/tokens.json` (Windows: `C:\Users\<you>\.vcf-orchestrator-mcp\tokens.json`) |
| Override | `VRO_TOKEN_FILE` |
| Contents | Per VCF Automation host and org: the latest refresh token, the client ID, the token endpoint, and when it was last updated |
| Permissions | Readable only by your user on Linux and macOS (`0600`) |

Treat this file like a password. The refresh token can do whatever the service account's roles allow.

## Things to know

- **One machine, one token chain.** Don't copy `tokens.json` to another machine. Whichever machine refreshes first invalidates the other's copy, and the other one gets `invalid_grant`. Run setup on each machine instead.
- **Role changes need a restart.** An access token carries the roles it was issued with. After you change the service account's roles, restart your MCP client so the server gets a fresh token.
- **Revoking access** is immediate: delete or disable the service account in **Access Control > Service Accounts**.
- **If the chain breaks** (account revoked, file deleted or copied), the error says *"The refresh token was already used or revoked. Run vcf-orchestrator-mcp setup again"*. Running setup again fixes it.
- `vro_server_info` shows `tokenExpiresAt`, the expiry of the current access token.

## Seeding a refresh token yourself

If you already have a refresh token from the [manual flow](https://cloudblogger.co.in/2026/05/29/end-to-end-vcf-automation-token-generation-via-rest-apis/), set `VRO_API_TOKEN` (and `VRO_CLIENT_ID`) instead of running setup. The server uses it once, then continues with the rotated tokens in the token file. Changing `VRO_API_TOKEN` to a different value starts a new chain.
