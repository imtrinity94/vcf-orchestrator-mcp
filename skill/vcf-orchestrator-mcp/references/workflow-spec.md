# vro_save_workflow spec format

`vro_save_workflow` builds a complete Orchestrator workflow from a compact JSON spec. It creates the folder path if missing, validates the spec, and bumps the version on every update.

## Top level

| Field | Required | Meaning |
|---|---|---|
| `folder` | yes | Folder path, e.g. `Lab/Utilities` (created if missing) |
| `name` | yes | Workflow name; with `folder` it decides whether this is a create or an update |
| `description` | no | Shown in the Orchestrator client |
| `inputs`, `outputs`, `attributes` | no | Lists of parameters (below) |
| `steps` | yes | Ordered list of steps (below) |
| `version` / `bump` | no | Explicit `x.y.z`, or `patch` (default), `minor`, `major` |
| `dryRun` | no | `true` returns the generated XML without saving |

## Parameters

```json
{ "name": "vmName", "type": "string", "description": "Exact VM name", "default": "web01" }
```

`type` is any Orchestrator type: `string`, `number`, `boolean`, `Date`, `SecureString`, `Properties`, `Array/string`, `VC:VirtualMachine`, `VRA:Host`, `ResourceElement`, ... `default` works for strings, numbers, booleans and arrays of strings.

## Steps

| Field | Meaning |
|---|---|
| `id` | Unique step id, used by `next`, `ifTrue`, `ifFalse` |
| `type` | `script` (default), `action`, `decision` or `end` |
| `name` | Name shown on the canvas |
| `script` | ES5 code. A decision's script must `return` a boolean. |
| `in` | Variables the step reads (inputs or attributes) |
| `out` | Variables the step writes (outputs or attributes only, never inputs) |
| `action` | For an action step: `module/actionName` |
| `args` | For an action step: `{ "actionParam": "workflowVariable" }`, in the action's parameter order |
| `resultTo` | For an action step: the variable that receives the return value |
| `next` | Next step id. Default: the following step, or the end. |
| `ifTrue`, `ifFalse` | For a decision: where to go |

Steps run in array order unless `next`, `ifTrue` or `ifFalse` say otherwise.

## Complete example

A workflow that looks up a VM by name, checks whether it is powered on, and returns a short report.

```json
{
  "folder": "Lab/Utilities",
  "name": "Report VM Power State",
  "description": "Finds a vCenter VM by exact name and reports whether it is powered on.",
  "inputs": [
    { "name": "vmName", "type": "string", "description": "Exact VM name in vCenter" }
  ],
  "outputs": [
    { "name": "report", "type": "string" }
  ],
  "attributes": [
    { "name": "vm", "type": "VC:VirtualMachine" },
    { "name": "powerState", "type": "string" }
  ],
  "steps": [
    {
      "id": "find",
      "name": "Find VM",
      "in": ["vmName"],
      "out": ["vm"],
      "script": "var found = VcPlugin.getAllVirtualMachines(null, \"xpath:name='\" + vmName + \"'\");\nif (!found || found.length === 0) { throw \"VM not found: \" + vmName; }\nvm = found[0];\nSystem.log(\"Found \" + vm.name);"
    },
    {
      "id": "state",
      "name": "Read power state",
      "in": ["vm"],
      "out": ["powerState"],
      "script": "powerState = vm.runtime.powerState.value;"
    },
    {
      "id": "isOn",
      "type": "decision",
      "name": "Powered on?",
      "in": ["powerState"],
      "script": "return powerState === \"poweredOn\";",
      "ifTrue": "reportOn",
      "ifFalse": "reportOff"
    },
    {
      "id": "reportOn",
      "name": "Report on",
      "in": ["vmName"],
      "out": ["report"],
      "script": "report = vmName + \" is powered on\";",
      "next": "done"
    },
    {
      "id": "reportOff",
      "name": "Report off",
      "in": ["vmName", "powerState"],
      "out": ["report"],
      "script": "report = vmName + \" is not powered on (\" + powerState + \")\";",
      "next": "done"
    },
    { "id": "done", "type": "end" }
  ]
}
```

To reuse a tested action instead of a script, write an action step:

```json
{
  "id": "find",
  "type": "action",
  "name": "Find VM",
  "action": "com.example.vc/getVmByName",
  "args": { "vmName": "vmName" },
  "resultTo": "vm"
}
```
