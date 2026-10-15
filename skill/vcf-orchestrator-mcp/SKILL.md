---
name: vcf-orchestrator-mcp
description: Use when the user asks to work with VCF Operations Orchestrator (vRO, Aria Automation Orchestrator) through the vcf-orchestrator-mcp server, for example "find the workflow that onboards VMs", "create a vRO action that ...", "build a workflow in my Orchestrator", "run this workflow and tell me why it failed", "show the last runs of ...", or "run a quick script on vRO". Also use when the user wants to set up or troubleshoot the vcf-orchestrator-mcp connection to VCF Automation 9.
---

# VCF Operations Orchestrator via vcf-orchestrator-mcp

This skill tells you how to work with VCF Operations Orchestrator 9.x (embedded in VCF Automation 9, or standalone) using the tools of the open-source **vcf-orchestrator-mcp** server (npm package `vcf-orchestrator-mcp`, source at github.com/imtrinity94/vcf-orchestrator-mcp). All tool names start with `vro_`.

## 1. Before anything else

1. Check that the `vro_` tools are available. If they are not, the server is not installed or not running: follow `references/setup.md` and stop until the user has set it up. Never ask the user to paste a password or token into the chat.
2. Call `vro_server_info` once per session. It returns the Orchestrator version, the auth mode and when the access token expires. If it reports `LOGIN FAILED`, use the troubleshooting table in `references/setup.md`.

## 2. Pick the right tool

| The user wants to | Use |
|---|---|
| Find or read a workflow | `vro_find_workflows` (partial name), then `vro_get_workflow` |
| Run a workflow | `vro_run_workflow` with plain JSON inputs; it waits and returns state, outputs, error and logs |
| See why a run failed / past runs | `vro_list_executions`, then `vro_get_execution` with logs |
| Find, read or run an action | `vro_find_actions`, `vro_get_action`, `vro_run_action` |
| Create or change an action | `vro_save_action` |
| Create or change a workflow | `vro_save_workflow` (compact JSON spec, see `references/workflow-spec.md`) |
| Try a snippet or inspect inventory | `vro_run_script` (temporary action, deleted afterwards) |
| Baseline or bump versions | `vro_set_versions` |
| Anything else in the REST API (packages, configuration and resource elements, folders, permissions, tasks, policies ...) | `vro_api_search` to find the operation, `vro_api_describe` to see its body, `vro_api_call` to call it |

Full parameter notes are in `references/tools.md`.

## 3. Rules for code you write

- **Orchestrator runs Rhino, so every script must be plain ES5.** Use `var` and `function () {}`. Never use arrow functions, `let`/`const`, template literals, classes, destructuring, default parameters, `for...of`, spread, `Promise` or `async`. Check this before every `vro_save_action`, `vro_save_workflow` and `vro_run_script` call.
- Use `System.log`, `System.warn` and `System.error` for logging, and `throw` errors with a clear message.
- Never hard-code passwords, tokens or keys in scripts. Use workflow inputs of type `SecureString`, or configuration elements, and say which one you chose.
- Versions are bumped automatically on every save (new item = 1.0.0, update = patch + 1). Use `bump: "minor"` or `"major"` for bigger changes. Do not set a version lower than the current one.
- Follow the user's naming conventions for modules, actions, workflows and folders. If they have none and the choice matters, ask once. Do not add "created by" or tool-name markers to names or descriptions.

## 4. How to work

1. **Look before you change.** Read the existing workflow or action first (`vro_get_workflow`, `vro_get_action`) and keep its inputs, outputs and behaviour unless the user asked to change them.
2. **Build in small steps and test each one.** Save an action, run it with `vro_run_action` using realistic inputs, read the result and logs, fix, save again. Then build the workflow on top of tested actions.
3. **Prefer a dry run** for anything that changes infrastructure (onboarding, deletes, reconfiguration). If the workflow has a `dryRun` input, run with `dryRun: true` first, show the user what would happen, and wait for a clear yes before the real run.
4. **When a run fails,** get the execution with logs, quote the error line, explain the cause in one or two sentences, fix it, and run again. Do not retry the same failing call unchanged.
5. **Deleting is destructive.** Before `vro_delete_workflow` or a `DELETE` with `vro_api_call`, name exactly what will be deleted and wait for the user to confirm.

## 5. Inputs and types

Pass inputs as plain JSON; the server converts them to Orchestrator types:

- `string`, `number`, `boolean` as JSON values; `Date` as an ISO string.
- `Properties` as a JSON object; `Array/string` (and other arrays) as a JSON array.
- `SecureString` as a string (it is sent as a secure value).
- Plug-in objects (`VC:VirtualMachine`, `VRA:Host`, ...) and built-in objects (`ResourceElement`, `ConfigurationElement`, ...) as their **id** string, or `{ "id": "...", "type": "..." }`.

If you don't know an object's id, find it first with `vro_run_script` (for example `return Server.findAllForType("VC:VirtualMachine", "name=web01");`) or with `vro_api_call`.

## 6. Reporting back

After a change, tell the user in a few lines: what you created or changed (with name, folder or module, and new version), what you tested and the result, and anything they still need to do. After a run, give the final state, the outputs that matter, and for a failure the error and your fix. Don't paste whole scripts back unless the user asks.

## Supporting files

- `references/setup.md`: install, one-time setup, client config, and troubleshooting.
- `references/tools.md`: every tool with its main parameters.
- `references/workflow-spec.md`: the `vro_save_workflow` spec format with a complete example.
- `examples/build-and-test-an-action.md`: a worked example of the build, test and fix loop.
