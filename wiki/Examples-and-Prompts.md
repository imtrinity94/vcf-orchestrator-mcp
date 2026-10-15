# Examples and Prompts

You talk to your assistant in plain language; it picks the tools. These prompts show what works well.

## Prompts to try

**Look around**
- "Run vro_server_info and tell me which Orchestrator I'm connected to."
- "List the workflows in my Onboarding folder with their versions."
- "Show me the inputs and outputs of the workflow *Onboard VMs by Name*."

**Run and investigate**
- "Run *Create VM Folder* with folderName=lab-01 and show me the logs."
- "Show the last 5 failed runs of workflow X and why they failed."
- "My *Onboard VMs from CSV* workflow failed. Check the last run, tell me why, and fix it."

**Build**
- "Write an action in com.example.lab that returns all vCenter VM names, run it and fix it until it works."
- "Create a vRO workflow that returns the names of all VMs in a vCenter folder, test it, and fix it if it fails."
- "Create a workflow in folder Lab/Onboarding that ... with vraHost preset to the default VRA host, then run it."

**Everything else in the REST API**
- "Find the API for exporting a package and export com.vmware.library."
- "List the configuration elements in folder Lab and show the attributes of *Settings*."
- "Bump all actions in module com.example.lab to version 1.1.0."

## Tips

- **Ask for a test.** "Run it and fix it until it works" makes the assistant use `vro_run_action` / `vro_run_workflow`, read the error and logs, and iterate.
- **Ask for a dry run** before anything that changes infrastructure, if the workflow has a `dryRun` input.
- **Name your conventions.** Tell the assistant your module, folder and naming standards once; it follows them.
- **Remind it about ES5 if needed.** Orchestrator runs Rhino. The server's tool descriptions already say so, and the [Agensi skill](#agent-skill) enforces it.
- **Keep tool approvals on** in your client, so you see each change before it happens.

## Walkthrough: build, test and fix an action

**Prompt:** "Create an action that returns the names of all VMs in a vCenter folder, and make sure it works."

1. The assistant checks the connection (`vro_server_info`) and whether a similar action exists (`vro_find_actions`).
2. It saves the action with `vro_save_action` (version 1.0.0):
   ```javascript
   if (!folder) { throw "folder is required"; }
   var names = [];
   var vms = folder.vm || [];
   for (var i = 0; i < vms.length; i++) {
     if (vms[i]) { names.push(vms[i].name); }
   }
   System.log("Found " + names.length + " VMs in " + folder.name);
   return names;
   ```
3. It looks up a real folder id with `vro_run_script`, then runs the action with `vro_run_action`.
4. If a run fails, it reads the error line, fixes the script, saves again (version 1.0.1) and re-runs.
5. It reports what it created, the version, and the test result.

## Walkthrough: onboard VMs into VCF Automation 9.1

This is the real lab example from the [blog post](https://cloudblogger.co.in/2026/10/14/vcf-orchestrator-mcp-claude-for-vcf-operations-orchestrator/). Bringing existing vCenter VMs under VCF Automation management goes through the onboarding (relocation) API: create a plan, find the unmanaged machines, add them as deployments, execute and wait.

Described in plain words, the assistant built through the MCP:

- **A module of actions**, one per API step: a REST helper, `getProjectId`, `getCloudAccountId`, `createOnboardingPlan`, `findUnmanagedMachines`, `addDeploymentsToPlan`, `executePlanAndWait`, `verifyOnboardedDeployments`.
- **An "Onboard VMs by Name" workflow** chaining them, with an optional dry run, plan-level custom properties (`onboardedStatus=true`, `workflowRun=true`) and per-VM properties.
- **A CSV wrapper workflow** that reads a CSV resource element and onboards all listed VMs in one plan, each with its own custom properties:
  ```
  vmName,customProperty1Key,customProperty1Value,customProperty2Key,customProperty2Value
  rhel9_1675,applicationName,LinuxWebPortal,costCenter,CC-1001
  test01,environment,Development,ownerTeam,PlatformOps
  ```
- **An unregister workflow** using the `Cloud.vSphere.Machine.Unregister` day-2 action.

When the first plan failed, the assistant read the plan state and found the cause: a deployment with the same name already existed (deployment names must be unique). It added a name prefix and the next run went through.

The full workflow spec is in the repo: [`examples/onboard-vms-by-name.workflow.json`](https://github.com/imtrinity94/vcf-orchestrator-mcp/blob/main/examples/onboard-vms-by-name.workflow.json).

## The vro_save_workflow spec

`vro_save_workflow` builds a complete workflow from compact JSON: inputs, outputs, attributes and ordered steps (script, action, decision, end) with bindings. The format and a complete example are in [`skill/vcf-orchestrator-mcp/references/workflow-spec.md`](https://github.com/imtrinity94/vcf-orchestrator-mcp/blob/main/skill/vcf-orchestrator-mcp/references/workflow-spec.md).

## Agent skill

The repo includes a free agent skill in [`skill/`](https://github.com/imtrinity94/vcf-orchestrator-mcp/tree/main/skill/vcf-orchestrator-mcp) that teaches agents when and how to use these tools: ES5 rules, build-and-test loop, dry runs, versioning and reporting. Copy the `vcf-orchestrator-mcp` folder into your agent's skills folder (for Claude Code: `~/.claude/skills/`).
