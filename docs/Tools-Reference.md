# Tool reference

All tools come from the vcf-orchestrator-mcp server. Workflows and actions can usually be referenced by id or by name (`module/name` for actions).

## Connection

| Tool | What it does | Main parameters |
|---|---|---|
| `vro_server_info` | Logs in and returns version, auth mode, token expiry and the loaded API spec. Call first, and whenever something fails. | none |

## Workflows

| Tool | What it does | Main parameters |
|---|---|---|
| `vro_find_workflows` | Search workflows by partial name. Returns id, name, folder, version, description. | `name`, `limit`, `startIndex` |
| `vro_get_workflow` | Inputs and outputs (names and types), version and description. | workflow id or exact name |
| `vro_run_workflow` | Runs a workflow with plain JSON inputs. Waits by default and returns state, outputs, error and logs. | `workflow`, `inputs`, `wait` (default true), `timeoutSeconds` (default 180, max 3600), `includeLogs` |
| `vro_get_execution` | State, outputs and error of one run, optionally with logs; can wait for it to finish. | execution id, logs, wait |
| `vro_list_executions` | Recent runs of a workflow: id, state, start and end, started by. | workflow |
| `vro_save_workflow` | Creates or updates a workflow (upsert by name + folder) from a compact spec. Creates the folder path if missing and bumps the version. `dryRun: true` only returns the generated XML. | `folder`, `name`, `description`, `inputs`, `outputs`, `attributes`, `steps`, `version` or `bump`, `dryRun`. See `workflow-spec.md`. |
| `vro_delete_workflow` | Deletes a workflow. Confirm with the user first. | workflow id or exact name |

## Actions

| Tool | What it does | Main parameters |
|---|---|---|
| `vro_find_actions` | Search actions by partial module or name. | `query`, `limit` |
| `vro_get_action` | Script, inputs and return type. | `module/name` or id |
| `vro_run_action` | Runs an action synchronously and returns its result, error with line number, and logs. | `action`, `inputs` |
| `vro_save_action` | Creates or updates an action (upsert by module/name). Omitted inputs or return type are kept on update. Bumps the version. | `module`, `name`, `script` (ES5), `inputs` [{name, type, description}], `returnType`, `description`, `version` or `bump` |
| `vro_run_script` | Runs an ES5 snippet as a temporary action and returns the `return` value and `System.log` output, then deletes the action. | `script` (function body, use `return`), `inputs`, `inputTypes`, `returnType` (default Any), `keepAction` |

## Versions

| Tool | What it does | Main parameters |
|---|---|---|
| `vro_set_versions` | Sets or bumps versions of actions (a whole module or a list) and workflows without touching their content. | `module`, `actions`, `workflows`, `version` or `bump`, `onlyIfBelow` (e.g. baseline everything below 1.0.0 to 1.0.0) |

## Packages

| Tool | What it does | Main parameters |
|---|---|---|
| `vro_export_package` | Downloads a package as a `.package` file on this computer and returns the saved path, size and the package's workflows, actions, configuration and resource elements. The file is byte-for-byte what Orchestrator exported, so it imports elsewhere and opens in [vRO Peekage](https://vro-peekage.vercel.app). An existing file is never overwritten unless asked; a `-2`, `-3` suffix is added. | `packageName`, `outDir` (default `VRO_DOWNLOAD_DIR`, else `~/Downloads/vro`), `fileName` (default `<package>_<yyyymmdd>.package`), `includeConfigValues` (default true), `includeSecureStrings` (default false), `includeVersionHistory`, `includeGlobalTags`, `overwrite` |

## Full REST API

The server includes the Orchestrator OpenAPI spec (300+ operations).

| Tool | What it does | Main parameters |
|---|---|---|
| `vro_api_search` | Finds operations by keyword, path fragment or operationId. `listTags: true` lists the API areas. | `query`, `tag`, `method`, `limit` |
| `vro_api_describe` | Shows one operation's path, query and header parameters, request body and response shape. Use before any call with a body. | `operationId` |
| `vro_api_call` | Calls any endpoint. Paths are relative to `/vco/api`. Inventory lists are flattened into `items` unless `raw: true`. Binary responses (zip, octet-stream, images) are saved to a file instead of returned as text, and the result gives `savedTo` and `bytes`. | `operationId` or `method` + `path`, `pathParams`, `query`, `body`, `accept`, `raw`, `includeHeaders`, `maxChars`, `saveTo` (folder or file path for binary responses) |

Example: download an exported workflow (`exportWorkflow`) or action (`exportAction`).

1. `vro_api_search` with query `export workflow`.
2. `vro_api_call` with that operationId, the id, and `accept: "application/zip"`. The file is saved and its path returned.

For packages, use `vro_export_package` instead.

## Notes

- `GET /workflows` doesn't accept `queryCount`; use `maxResult` and `startIndex`.
- Updating a folder (category) with `PUT /categories/{id}` needs `name`, `type` and `parent-category-id`, otherwise the folder moves to the root.
- Action versions can't be changed from scripting; use `vro_save_action` or `vro_set_versions`.
