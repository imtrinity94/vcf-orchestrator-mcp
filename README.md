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
| `vro_save_workflow` | Create/update a workflow from a compact spec (inputs, outputs, attributes, script/action/decision/end steps); creates the folder path. Attributes can preset SDK objects by inventory id, e.g. `{name:'vraHost', type:'VRA:Host', default:'<host id>'}` |
| `vro_delete_workflow` | Delete a workflow by id or name |
| `vro_run_script` | Run an ad-hoc ES5 snippet via a temp action (auto-deleted) — for prototyping |

Inputs are converted automatically from plain JSON to Orchestrator types: `string`, `number`, `boolean`, `Date`, `Properties`, `Array/x`, `SecureString`, and SDK objects. For SDK objects, pass the id string or `{type,id}`, e.g. `VC:VirtualMachine`. Outputs are converted back to plain JSON.

## Quick start (bearer token)

Verified against **VCF Automation 9.1.1 with the embedded Orchestrator**. This is the simplest way to start.

1. Install it once globally (Node 18.17+):

   ```bash
   npm install -g vcf-orchestrator-mcp
   ```

2. Get a bearer token. Sign in to VCF Automation in the browser and open the developer tools (F12) → **Network**. Click any API request to your VCFA host and copy the value after `Authorization: Bearer `. UI tokens are short-lived (about 1 hour), so refresh it when calls start returning 401.

3. Add the server to Claude Desktop. On Windows the config file is `%APPDATA%\Claude\claude_desktop_config.json`; get there via Settings → Developer → Edit Config.

   ```json
   {
     "mcpServers": {
       "vcf-orchestrator": {
         "command": "vcf-orchestrator-mcp",
         "env": {
           "VRO_URL": "https://auto.example.lab",
           "VRO_AUTH_MODE": "token",
           "VRO_TOKEN": "eyJraWQiOi...",
           "VRO_INSECURE": "true"
         }
       }
     }
   }
   ```

   `VRO_TOKEN` takes the token with or without the `Bearer ` prefix. Set `VRO_INSECURE` to `true` only for self-signed lab certificates.

4. Fully quit Claude Desktop (from the system tray) and reopen it. Then ask Claude: *"run vro_server_info"*.

For Claude Code, run:

```bash
claude mcp add vcf-orchestrator -e VRO_URL=https://auto.example.lab -e VRO_AUTH_MODE=token -e VRO_TOKEN=eyJ... -e VRO_INSECURE=true -- vcf-orchestrator-mcp
```

**Avoid `npx -y vcf-orchestrator-mcp` in Claude Desktop.** `npx` re-checks the registry on every launch, and on Windows that can take longer than Claude Desktop waits for the first handshake, so the server shows as failed. Install globally instead. To upgrade, run `npm update -g vcf-orchestrator-mcp`.

To run from source, `git clone` the repo and run `npm install` (which also builds it), then use `"command": "node", "args": ["<path>/dist/index.js"]`.

## Configuration (environment variables)

| Var | Default | Notes |
|---|---|---|
| `VRO_URL` | — **required** | Embedded: your VCF Automation host · External: the Orchestrator appliance |
| `VRO_AUTH_MODE` | `auto` | `token` (verified) \| `vcfa-cloudapi` \| `vcfa` \| `basic` \| `auto` |
| `VRO_TOKEN` | | Bearer token for `token` mode |
| `VRO_INSECURE` | `false` | `true` for self-signed lab certs |
| `VRO_API_BASE` | `/vco/api` | |
| `VRO_USERNAME` / `VRO_PASSWORD` | | For the login modes below |
| `VRO_ORG` | | VCFA org for `vcfa-cloudapi` (`System` = provider) |
| `VRO_DOMAIN` | | Identity domain for `vcfa` login |
| `VRO_AUTH_URL` | `VRO_URL` | Login host, when Orchestrator authenticates against a **different** VCF Automation host |
| `VRO_SPEC_PATH` | bundled spec | Drop in a newer OpenAPI spec without rebuilding |
| `VRO_MAX_CHARS` | `25000` | Response truncation limit per tool call |
| `VRO_TIMEOUT_MS` | `60000` | |
| `VRO_SCRATCH_MODULE` | `com.mcp.scratch` | Module for `vro_run_script` temp actions |

### Username/password login modes (not yet verified)

These modes log in with a username and password and get a token automatically. They are **not yet verified** against VCFA 9.x.

- **`vcfa-cloudapi`**: `POST /cloudapi/1.0.0/sessions[/provider]` as `user@org`, then uses the returned `x-vmware-vcloud-access-token` as the bearer token. This is the VCF Automation 9 org model. Set `VRO_ORG`.
- **`vcfa`**: CSP login (`/csp/gateway/am/api/login`). This is the Aria Automation 8 style; VCFA 9 doesn't offer it.
- **`basic`**: HTTP Basic auth, for external Orchestrator configured with vSphere SSO.
- **`auto`**: tries `token`, then `vcfa-cloudapi`, then `vcfa`, then `basic`.

When login fails, `vro_server_info` returns the error plus unauthenticated probes of every login endpoint. That shows which login flavours your host offers. In the password modes, the token is re-fetched automatically when a call returns 401.

## Tips for prompting

- "Run *Create VM Folder* with folderName=lab-01 and show me the logs"
- "Write an action in com.mayank.lab that returns all vCenter VM names, run it and fix it until it works"
- "Find the API for exporting a package and export com.vmware.library to a file"
- "Show the last 5 failed runs of workflow X and why they failed"
- "Create a workflow in folder Lab/Onboarding that ... with vraHost preset to the Default VRA host, then run it"

`examples/onboard-vms-by-name.workflow.json` is a full `vro_save_workflow` spec. It's an onboarding workflow that brings unmanaged VMs into a VCF Automation project, and it has been run end to end on VCF Automation 9.1.1.

## Testing

`test-client.mjs` exercises every tool over stdio. Point it at a mock or a lab Orchestrator through the env vars in the file.

## Releasing

Pushing a `v*` tag publishes to npm through `.github/workflows/publish.yml`. It uses npm trusted publishing (OIDC), so no token is stored anywhere. To enable it once, open the package on npmjs.com → Settings → Trusted Publisher and add GitHub Actions with repo `imtrinity94/vcf-orchestrator-mcp` and workflow `publish.yml`. Then release with:

```bash
npm version patch && git push --follow-tags
```

## License

MIT
