# vcf-orchestrator-mcp

MCP server that lets Claude work directly with **VCF Operations Orchestrator (vRO) 9.x**. It works both **embedded in VCF Automation** and **external/standalone** (the All Apps case).

It is spec-driven: the bundled OpenAPI file (`spec/vcfoo-9.0.0.json`, 303 operations) is indexed at startup. That gives Claude the whole REST API through 3 generic tools, without registering 300 tools. On top of those sit curated tools for day-to-day work.

## Tools

| Tool | What it does |
|---|---|
| `vro_server_info` | Connectivity check: login, `/about`, auth mode chosen, spec loaded |
| `vro_api_search` | Keyword search over all API operations → operationIds |
| `vro_api_describe` | Params + request/response schema for one operation (`$ref`s resolved) |
| `vro_api_call` | Call **any** endpoint by operationId or method+path (full access) |
| `vro_find_workflows` / `vro_get_workflow` | Find workflows, see inputs/outputs |
| `vro_run_workflow` | Run by id **or name** with plain JSON inputs; waits, returns outputs, error, logs |
| `vro_get_execution` / `vro_list_executions` | Inspect runs, logs, optional wait |
| `vro_find_actions` / `vro_get_action` | Find actions, read script / inputs / return type |
| `vro_run_action` | Execute an action, returns plain JSON result + logs |
| `vro_save_action` | Create or update (upsert) an action |
| `vro_run_script` | Run an ad-hoc ES5 snippet via a temp action (auto-deleted) — for prototyping |

Inputs are converted automatically from plain JSON to Orchestrator types: `string`, `number`, `boolean`, `Date`, `Properties`, `Array/x`, `SecureString`, and SDK objects. For SDK objects, pass the id string or `{type,id}`, e.g. `VC:VirtualMachine`. Outputs are converted back to plain JSON.

## Configuration (environment variables)

| Var | Default | Notes |
|---|---|---|
| `VRO_URL` | — **required** | Embedded: `https://auto.vmw.lab` · External: `https://vro.vmw.lab` |
| `VRO_API_BASE` | `/vco/api` | |
| `VRO_AUTH_MODE` | `auto` | `auto` \| `vcfa` \| `vcfa-cloudapi` \| `basic` \| `token` |
| `VRO_USERNAME` / `VRO_PASSWORD` | | |
| `VRO_DOMAIN` | | Identity domain for `vcfa` login (e.g. `vsphere.local`, `System Domain`, AD domain) |
| `VRO_ORG` | | VCFA org for `vcfa-cloudapi` (`System` = provider) |
| `VRO_AUTH_URL` | `VRO_URL` | Where to log in when Orchestrator authenticates against a **different** VCF Automation host |
| `VRO_TOKEN` | | Static bearer token (`token` mode) |
| `VRO_INSECURE` | `false` | `true` for self-signed lab certs |
| `VRO_SPEC_PATH` | bundled 9.0.0 spec | Drop in a newer spec without rebuilding |
| `VRO_MAX_CHARS` | `25000` | Response truncation limit per tool call |
| `VRO_TIMEOUT_MS` | `60000` | |
| `VRO_SCRATCH_MODULE` | `com.mcp.scratch` | Module for `vro_run_script` temp actions |

### Auth modes

- **`vcfa`**: `POST {authUrl}/csp/gateway/am/api/login` (+ `/iaas/api/login` if needed) → Bearer. Classic VCF Automation / All Apps and Aria Automation 8 flow. This covers embedded Orchestrator and external Orchestrator registered to VCF Automation (set `VRO_AUTH_URL` to the VCFA host).
- **`vcfa-cloudapi`**: `POST {authUrl}/cloudapi/1.0.0/sessions[/provider]` as `user@org` → `x-vmware-vcloud-access-token` as Bearer (VCF Automation 9 org model).
- **`basic`**: HTTP Basic on every call. Use this for external Orchestrator configured with vSphere SSO auth.
- **`auto`** tries each mode in turn and keeps the first one Orchestrator accepts. The order is `token` → `vcfa-cloudapi` (if `VRO_ORG` is set) → `vcfa` → `basic`. Pin a mode once you know which one your setup uses.

Tokens are refreshed automatically on a 401.

## Install

No install step is needed — Claude Desktop runs it with `npx` (Node 18.17+ required):

```bash
npx -y vcf-orchestrator-mcp
```

To run from source instead: `git clone`, `npm install`, `npm run build`, then point `command`/`args` at `node dist/index.js`.

## Claude Desktop (Windows) — `%APPDATA%\Claude\claude_desktop_config.json`

Embedded (Orchestrator inside VCF Automation):

```json
{
  "mcpServers": {
    "vcf-orchestrator": {
      "command": "npx",
      "args": ["-y", "vcf-orchestrator-mcp"],
      "env": {
        "VRO_URL": "https://auto.vmw.lab",
        "VRO_AUTH_MODE": "vcfa",
        "VRO_USERNAME": "configadmin",
        "VRO_PASSWORD": "********",
        "VRO_INSECURE": "true"
      }
    }
  }
}
```

External / All Apps (Orchestrator on its own appliance, authenticating via VCF Automation):

```json
"env": {
  "VRO_URL": "https://vro.vmw.lab",
  "VRO_AUTH_URL": "https://auto.vmw.lab",
  "VRO_AUTH_MODE": "vcfa",
  "VRO_USERNAME": "configadmin",
  "VRO_PASSWORD": "********",
  "VRO_INSECURE": "true"
}
```

External with vSphere SSO auth: `"VRO_AUTH_MODE": "basic"` and `"VRO_USERNAME": "administrator@vsphere.local"`.

Claude Code: `claude mcp add vcf-orchestrator -e VRO_URL=https://auto.vmw.lab -e VRO_USERNAME=... -e VRO_PASSWORD=... -e VRO_INSECURE=true -- npx -y vcf-orchestrator-mcp`

## Tips for prompting

- "Run *Create VM Folder* with folderName=lab-01 and show me the logs"
- "Write an action in com.mayank.lab that returns all vCenter VM names, run it and fix it until it works"
- "Find the API for exporting a package and export com.vmware.library to a file"
- "Show the last 5 failed runs of workflow X and why they failed"

## Testing

`test-client.mjs` exercises every tool over stdio. Point it at a mock or a lab Orchestrator through the env vars in the file.

## Releasing

Pushing a `v*` tag publishes to npm through `.github/workflows/publish.yml`. This needs an `NPM_TOKEN` repository secret holding an npm automation / granular token with publish rights:

```bash
npm version patch && git push --follow-tags
```

## License

MIT
