# Example: build, test and fix an action

**User:** "Create an action that returns the names of all VMs in a vCenter folder, and make sure it works."

## 1. Check the connection and look for existing work

- `vro_server_info`: connected, Orchestrator 9.1.1, auth mode `api-token`.
- `vro_find_actions` with query `getVmsInFolder`: nothing found, so this is a new action.
- If the user has a module naming convention, use it. Otherwise ask once which module to use, or suggest one like `com.example.vc`.

## 2. Write it in ES5 and save it

`vro_save_action`:

```json
{
  "module": "com.example.vc",
  "name": "getVmNamesInFolder",
  "description": "Returns the names of all VMs directly in a vCenter VM folder.",
  "inputs": [ { "name": "folder", "type": "VC:VmFolder", "description": "vCenter VM folder" } ],
  "returnType": "Array/string",
  "script": "if (!folder) { throw \"folder is required\"; }\nvar names = [];\nvar vms = folder.vm || [];\nfor (var i = 0; i < vms.length; i++) {\n  names.push(vms[i].name);\n}\nSystem.log(\"Found \" + names.length + \" VMs in \" + folder.name);\nreturn names;"
}
```

The tool returns the new action with version `1.0.0`.

## 3. Find a real input to test with

The input is a plug-in object, so get its id first. `vro_run_script`:

```javascript
var folders = VcPlugin.getAllVmFolders(null, "xpath:name='Test VMs'");
return folders.length ? folders[0].id : "not found";
```

## 4. Run it

`vro_run_action` with `{ "action": "com.example.vc/getVmNamesInFolder", "inputs": { "folder": "<id from step 3>" } }`.

Suppose it fails with `TypeError: Cannot read property "name" of null` on line 5. Some entries in `folder.vm` can be null.

## 5. Fix, save again, re-run

Change the loop to skip empty entries:

```javascript
for (var i = 0; i < vms.length; i++) {
  if (vms[i]) { names.push(vms[i].name); }
}
```

Save with `vro_save_action`. The version becomes `1.0.1`. Run it again: it returns `["rhel9-01", "test01", "web01"]`.

## 6. Report back

> I created `com.example.vc/getVmNamesInFolder` (version 1.0.1). It takes a `VC:VmFolder` and returns the VM names as `Array/string`. I tested it on the "Test VMs" folder: it returned 3 VMs. The first run failed on an empty folder entry, so I added a null check.
