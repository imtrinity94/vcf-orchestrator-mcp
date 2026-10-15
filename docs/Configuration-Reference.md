# Configuration Reference

The server is configured with environment variables, set in the `env` block of your [client config](Client-Configuration.md).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `VRO_URL` | **required** | Embedded: your VCF Automation host, e.g. `https://auto.vmw.lab`. External: the Orchestrator appliance. |
| `VRO_AUTH_MODE` | `auto` | `api-token` (recommended), `token`, `vcfa-cloudapi`, `vcfa`, `basic` or `auto`. See [Auth modes](#auth-modes). |
| `VRO_ORG` | | VCF Automation org **name** for `api-token` and `vcfa-cloudapi`. `System` means the provider. |
| `VRO_INSECURE` | `false` | `true` accepts self-signed certificates (labs). |
| `VRO_TOKEN_FILE` | `~/.vcf-orchestrator-mcp/tokens.json` | Where the rotated refresh tokens are kept. |
| `VRO_API_TOKEN` | | Optional seed refresh token for `api-token` mode. Setup stores one for you. Alias: `VRO_REFRESH_TOKEN`. |
| `VRO_CLIENT_ID` | | Service account client ID. Setup stores it. |
| `VRO_TOKEN` | | A short-lived bearer token for `token` mode. |
| `VRO_USERNAME`, `VRO_PASSWORD` | | For the username/password modes. |
| `VRO_DOMAIN` | | Identity domain for `vcfa` mode. |
| `VRO_AUTH_URL` | `VRO_URL` | Login host, when Orchestrator authenticates against a **different** VCF Automation host. |
| `VRO_CLOUDAPI_VERSION` | `9.1.0` | API version header for the cloudapi session login. |
| `VRO_API_BASE` | `/vco/api` | Orchestrator API base path. |
| `VRO_SPEC_PATH` | bundled spec | Use a newer Orchestrator OpenAPI spec without rebuilding. |
| `VRO_MAX_CHARS` | `25000` | Maximum characters per tool response before truncation. |
| `VRO_TIMEOUT_MS` | `60000` | HTTP timeout per request. |
| `VRO_SCRATCH_MODULE` | `com.mcp.scratch` | Module for the temporary actions created by `vro_run_script`. |

## Auth modes

| Mode | Status | How it logs in | Use it when |
|---|---|---|---|
| `api-token` | **Recommended, verified** on VCF Automation 9.1.1 | Service account refresh token from [setup](Setup-and-Service-Account.md), renewed automatically ([Token Refresh](Token-Refresh.md)) | Always, unless you have a reason not to |
| `token` | Verified | A bearer token you paste into `VRO_TOKEN`. Expires after about an hour and is not renewed. | A quick test without setup |
| `vcfa-cloudapi` | Not yet verified | Username and password: `POST /cloudapi/1.0.0/sessions` (fallback `/tm/cloudapi/...`, provider `/sessions/provider`) as `user@org`; uses the `x-vmware-vcloud-access-token` header. Logs in again when needed. | You can't use a service account. Keeps the password in the config. |
| `vcfa` | Legacy | CSP login (`/csp/gateway/am/api/login`), the Aria Automation 8 style | Aria Automation 8.x. VCF Automation 9 doesn't offer it. |
| `basic` | Not yet verified | HTTP Basic auth | External Orchestrator configured with vSphere SSO |
| `auto` | | Tries `api-token`, then `token`, then `vcfa-cloudapi`, `vcfa`, `basic` | You're not sure; prefer setting a mode explicitly |

When login fails, `vro_server_info` returns the error and probes every login endpoint without credentials, which shows which login types your host offers.

## Examples

**Embedded Orchestrator in VCF Automation 9 (recommended):**

```json
"env": {
  "VRO_URL": "https://auto.vmw.lab",
  "VRO_AUTH_MODE": "api-token",
  "VRO_ORG": "vmapps-org",
  "VRO_INSECURE": "true"
}
```

**Quick test with a pasted token** (expires within the hour):

```json
"env": {
  "VRO_URL": "https://auto.vmw.lab",
  "VRO_AUTH_MODE": "token",
  "VRO_TOKEN": "<Authorization: Bearer value from the browser dev tools>",
  "VRO_INSECURE": "true"
}
```

**Standalone Orchestrator that logs in against a different VCF Automation host:**

```json
"env": {
  "VRO_URL": "https://vro.vmw.lab",
  "VRO_AUTH_URL": "https://auto.vmw.lab",
  "VRO_AUTH_MODE": "api-token",
  "VRO_ORG": "vmapps-org"
}
```
