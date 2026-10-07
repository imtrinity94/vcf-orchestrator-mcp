import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, VRO_URL: "http://127.0.0.1:18443", VRO_USERNAME: "admin", VRO_PASSWORD: "pw" },
  stderr: "inherit",
});
const c = new Client({ name: "t", version: "1" });
await c.connect(transport);
const tools = await c.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? "  [isError]" : ""}\n` + r.content[0].text.slice(0, 1400));
};
await call("vro_server_info", {});
await call("vro_api_search", { query: "workflow execution logs", limit: 5 });
await call("vro_api_describe", { operationId: "startWorkflowExecution", depth: 2 });
await call("vro_find_workflows", { name: "folder" });
await call("vro_run_workflow", { workflow: "Create VM Folder", inputs: { folderName: "lab-01", count: 3, tags: ["a", "b"], props: { env: "lab", n: 1 } } });
await call("vro_run_workflow", { workflow: "Create VM Folder", inputs: { folderName: "fail" } });
await call("vro_run_workflow", { workflow: "Create VM Folder", inputs: { nope: 1 } });
await call("vro_api_call", { operationId: "getWorkflow", pathParams: { id: "11111111-2222-3333-4444-555555555555" } });
await call("vro_api_call", { method: "GET", path: "/workflows", query: { conditions: ["name~vm"] } });
await call("vro_api_call", { operationId: "getWorkflow" });
await call("vro_find_actions", { query: "echo" });
await call("vro_run_action", { action: "com.vmware.library.util/echo", inputs: { msg: "hi" } });
await call("vro_save_action", { module: "com.mayank.lab", name: "add", script: "System.log('adding'); return a + b;", inputs: [{ name: "a", type: "number" }, { name: "b", type: "number" }], returnType: "number" });
await call("vro_save_action", { module: "com.mayank.lab", name: "add", script: "return a * b;" });
await call("vro_get_action", { action: "com.mayank.lab.add" });
await call("vro_run_script", { script: "System.log('hello ' + who); var o = {}; o.items = list; return o;", inputs: { who: "Mayank", list: [1, 2] } });
await call("vro_run_script", { script: "throw new Error('nope');" });
await call("vro_find_actions", { query: "mcp_" });
await c.close();
