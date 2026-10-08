#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { OrchestratorClient } from "./client.js";
import { SpecIndex } from "./spec.js";
import { buildParameters, fromWire, paramsToObject, type ParamDef } from "./values.js";
import { buildWorkflowXml, validateSpec, type WfSpec } from "./workflow.js";

const cfg = loadConfig();
const spec = new SpecIndex(cfg.specPath);
const vro = new OrchestratorClient(cfg);

// ---------------------------------------------------------------- helpers

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function out(data: unknown, maxChars = cfg.maxChars): ToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text === undefined) text = "null";
  if (text.length > maxChars) {
    text =
      text.slice(0, maxChars) +
      `\n…[truncated: ${text.length} chars total, showing ${maxChars}. Narrow the query (maxResult/startIndex/conditions/keys) or raise maxChars.]`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function tool<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      const r = await fn(args);
      return r && typeof r === "object" && "content" in (r as any) ? (r as ToolResult) : out(r);
    } catch (e) {
      return fail(e);
    }
  };
}

function pick(o: any, ...keys: string[]) {
  for (const k of keys) if (o?.[k] !== undefined) return o[k];
  return undefined;
}

/** Turn vRO "link[].attributes[{name,value}]" inventory lists into plain objects */
function flattenInventory(body: any): any {
  if (!body || typeof body !== "object" || !Array.isArray(body.link)) return body;
  if (!body.link.some((l: any) => Array.isArray(l?.attributes) || Array.isArray(l?.attribute))) return body;
  const items = body.link.map((l: any) => {
    const o: Record<string, unknown> = {};
    for (const a of l.attributes ?? l.attribute ?? []) o[a.name] = a.value;
    if (l.href && !o.href) o.href = l.href;
    return o;
  });
  const { link, ...rest } = body;
  return { ...rest, items };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

function paramDefs(list: any[] | undefined): ParamDef[] {
  return (list ?? []).map((p: any) => ({ name: p.name, type: p.type, description: p.description }));
}

function simplifyLogs(body: any, limit: number): any[] {
  if (!body) return [];
  if (typeof body === "string") return body.split(/\r?\n/).filter(Boolean).slice(-limit);
  const list = body.logs ?? body.log ?? body.sysLogs ?? (Array.isArray(body) ? body : []);
  return (Array.isArray(list) ? list : [list]).slice(-limit).map((l: any) => {
    const e = l.entry ?? l;
    return {
      time: pick(e, "time-stamp", "timeStamp", "timestamp"),
      severity: e.severity,
      message: pick(e, "short-description", "shortDescription", "message", "description"),
      ...(pick(e, "long-description", "longDescription") ? { detail: pick(e, "long-description", "longDescription") } : {}),
    };
  });
}

// ---------- workflows

async function resolveWorkflowId(idOrName: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(idOrName)) return idOrName;
  for (const cond of [`name=${idOrName}`, `name~${idOrName}`]) {
    const r = await vro.call("GET", "/workflows", { query: { conditions: cond, maxResult: 20 } });
    const items = flattenInventory(r.body)?.items ?? [];
    const exact = items.filter((i: any) => String(i.name).toLowerCase() === idOrName.toLowerCase());
    const hits = exact.length ? exact : items;
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
      throw new Error(
        `"${idOrName}" matches ${hits.length} workflows — pass the id instead:\n` +
          hits.map((h: any) => `  ${h.id}  ${h.name}  (${h.categoryName ?? h.globalTags ?? ""})`).join("\n")
      );
    }
  }
  throw new Error(`No workflow found matching "${idOrName}"`);
}

async function getWorkflowDef(id: string) {
  const r = await vro.call("GET", `/workflows/${enc(id)}`);
  const w: any = r.body;
  return {
    id: w.id,
    name: w.name,
    version: w.version,
    description: w.description,
    categoryId: pick(w, "category-id", "categoryId"),
    inputs: paramDefs(pick(w, "input-parameters", "inputParameters")),
    outputs: paramDefs(pick(w, "output-parameters", "outputParameters")),
  };
}

async function fetchExecutionLogs(workflowId: string, executionId: string, limit: number) {
  const base = `/workflows/${enc(workflowId)}/executions/${enc(executionId)}`;
  for (const p of ["/syslogs", "/logs"]) {
    const r = await vro.request("GET", base + p, { query: { maxResult: limit } });
    if (r.ok) {
      const logs = simplifyLogs(r.body, limit);
      if (logs.length) return logs;
    }
  }
  return [];
}

function summarizeExecution(e: any) {
  return {
    executionId: e.id,
    workflow: e.name,
    state: e.state,
    businessState: pick(e, "business-state", "businessState"),
    startedBy: pick(e, "started-by", "startedBy"),
    start: pick(e, "start-date", "startDate"),
    end: pick(e, "end-date", "endDate"),
    currentItem: pick(e, "current-item-display-name", "currentItemDisplayName"),
    error: pick(e, "content-exception", "contentException"),
    outputs: paramsToObject(pick(e, "output-parameters", "outputParameters")),
  };
}

async function getExecution(workflowId: string, executionId: string) {
  const r = await vro.call("GET", `/workflows/${enc(workflowId)}/executions/${enc(executionId)}`, {
    query: { showDetails: true },
  });
  return r.body as any;
}

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const STOP_WAITING = new Set(["waiting", "waiting-signal", "suspended"]);

async function waitForExecution(workflowId: string, executionId: string, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000;
  let delay = 1000;
  let last: any;
  while (Date.now() < deadline) {
    last = await getExecution(workflowId, executionId);
    if (TERMINAL.has(last.state) || STOP_WAITING.has(last.state)) return { exec: last, timedOut: false };
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
  }
  return { exec: last ?? (await getExecution(workflowId, executionId)), timedOut: true };
}

// ---------- actions

function parseActionRef(ref: string): { module: string; name: string } | { id: string } {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return { id: ref };
  const slash = ref.lastIndexOf("/");
  if (slash > 0) return { module: ref.slice(0, slash), name: ref.slice(slash + 1) };
  const dot = ref.lastIndexOf(".");
  if (dot > 0) return { module: ref.slice(0, dot), name: ref.slice(dot + 1) };
  throw new Error(`Action reference "${ref}" must be "module/actionName" (e.g. com.vmware.library.vc.vm/getAllVMs) or an action id`);
}

async function getAction(ref: string): Promise<any> {
  const p = parseActionRef(ref);
  const r = "id" in p
    ? await vro.call("GET", `/actions/${enc(p.id)}`)
    : await vro.call("GET", `/actions/${enc(p.module)}/${enc(p.name)}`);
  return r.body;
}

function summarizeAction(a: any, withScript = true) {
  return {
    id: a.id,
    fqn: a.fqn ?? `${a.module}/${a.name}`,
    module: a.module,
    name: a.name,
    version: a.version,
    description: a.description,
    returnType: pick(a, "output-type", "outputParameterType", "outputType"),
    inputs: paramDefs(pick(a, "input-parameters", "inputParameters")),
    runtime: a.runtime,
    ...(withScript ? { script: a.script } : {}),
  };
}

async function executeAction(action: any, inputs: Record<string, unknown>, strict = true) {
  const defs = paramDefs(pick(action, "input-parameters", "inputParameters"));
  const parameters = buildParameters(defs, inputs ?? {}, strict);
  const r = await vro.call("POST", `/actions/${enc(action.module)}/${enc(action.name)}/executions`, {
    body: { parameters },
  });
  const res: any = r.body ?? {};
  const execId = pick(res, "execution-id", "executionId");
  let logs: any[] = [];
  if (execId) {
    const lr = await vro.request("GET", `/actions/${enc(execId)}/logs`, { accept: "application/json, text/plain, */*" });
    if (lr.ok) logs = simplifyLogs(lr.body, 200);
  }
  return {
    state: res.state,
    executionId: execId,
    returnType: res.type,
    result: res.value === undefined ? null : fromWire(res.value),
    ...(res.errorMessage ? { error: res.errorMessage, errorLine: res.errorLineNumber } : {}),
    logs,
  };
}

async function saveAction(a: {
  module: string;
  name: string;
  script: string;
  inputs?: ParamDef[];
  returnType?: string;
  description?: string;
}) {
  let existing: any;
  const probe = await vro.request("GET", `/actions/${enc(a.module)}/${enc(a.name)}`);
  if (probe.ok) existing = probe.body;
  const body: any = {
    ...(existing ? { id: existing.id } : {}),
    module: a.module,
    name: a.name,
    script: a.script,
    description: a.description ?? existing?.description ?? "",
    "input-parameters": (a.inputs ?? paramDefs(pick(existing, "input-parameters", "inputParameters"))).map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description ?? "",
    })),
    "output-type": a.returnType ?? pick(existing, "output-type", "outputParameterType") ?? "void",
  };
  if (existing) {
    await vro.call("PUT", `/actions/${enc(existing.id)}`, { body });
  } else {
    await vro.call("POST", "/actions", { body });
  }
  const saved = await getAction(`${a.module}/${a.name}`);
  return { created: !existing, action: summarizeAction(saved, false) };
}

// ---------------------------------------------------------------- server

const server = new McpServer({ name: "vcf-orchestrator", version: "0.2.3" });

const jsonObj = z.record(z.string(), z.any());

server.registerTool(
  "vro_server_info",
  {
    description:
      "Check connectivity to VCF Operations Orchestrator: logs in, returns the server's /about info, the auth mode in use, and the loaded API spec. Call this first if anything fails.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    try {
      await vro.login();
    } catch (e: any) {
      return out({
        status: "LOGIN FAILED",
        error: e.message,
        config: {
          url: `${cfg.url}${cfg.apiBase}`,
          authUrl: cfg.authUrl,
          authMode: cfg.authMode,
          username: cfg.username,
          domain: cfg.domain,
          org: cfg.org,
        },
        probes: await vro.diagnose(),
        hint:
          "404 on a probe = that login flavour isn't offered by the host. VCF Automation 9 tenant orgs: VRO_AUTH_MODE=vcfa-cloudapi + VRO_ORG=<org name>. Provider: VRO_ORG=System.",
      });
    }
    const about = await vro.request("GET", "/about");
    return {
      url: `${cfg.url}${cfg.apiBase}`,
      authMode: vro.authMode,
      about: about.ok ? about.body : `HTTP ${about.status}`,
      spec: { title: spec.title, version: spec.version, operations: spec.ops.length, file: cfg.specPath },
    };
  })
);

// ---- generic, spec-driven

server.registerTool(
  "vro_api_search",
  {
    description:
      "Search the Orchestrator REST API spec (300+ operations) by keyword, e.g. 'workflow execution logs', 'configuration element', 'package export', 'resource element'. Returns operationIds to use with vro_api_describe / vro_api_call. Pass query='' with listTags=true to see API areas.",
    inputSchema: {
      query: z.string().describe("Keywords, a path fragment like '/packages', or an operationId"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      tag: z.string().optional().describe("Restrict to an API area (tag), partial match"),
      limit: z.number().int().min(1).max(60).optional(),
      listTags: z.boolean().optional().describe("Also return all API tags with operation counts"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { query: string; method?: string; tag?: string; limit?: number; listTags?: boolean }) => ({
    results: spec.search(a.query, { method: a.method, tag: a.tag, limit: a.limit }),
    ...(a.listTags ? { tags: spec.tags() } : {}),
  }))
);

server.registerTool(
  "vro_api_describe",
  {
    description:
      "Show one Orchestrator API operation in detail: path/query/header parameters, request body schema ($refs resolved) and success response shape. Use before vro_api_call for anything with a body.",
    inputSchema: {
      operationId: z.string(),
      depth: z.number().int().min(1).max(6).optional().describe("How deep to inline nested schemas (default 3)"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { operationId: string; depth?: number }) => {
    const d = spec.describe(a.operationId, a.depth ?? 3);
    if (!d) {
      const near = spec.search(a.operationId, { limit: 8 });
      throw new Error(`Unknown operationId "${a.operationId}". Closest: ${near.map((n) => n.operationId).join(", ")}`);
    }
    return d;
  })
);

server.registerTool(
  "vro_api_call",
  {
    description:
      "Call any Orchestrator REST endpoint (full access — GET/POST/PUT/PATCH/DELETE). Identify it by operationId (preferred, from vro_api_search) or by method + path relative to /vco/api. Inventory lists (link/attributes) are flattened into 'items' unless raw=true.",
    inputSchema: {
      operationId: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      path: z.string().optional().describe("e.g. /workflows/{id} or a concrete /workflows/abc-123; relative to the API base"),
      pathParams: jsonObj.optional().describe("Values for {placeholders} in the path"),
      query: jsonObj.optional().describe("Query params; arrays become repeated keys (e.g. conditions: ['name~vm'])"),
      body: z.any().optional().describe("JSON body (object) or a raw string (XML/text)"),
      headers: z.record(z.string(), z.string()).optional(),
      accept: z.string().optional().describe("json (default) | xml | text | explicit media type"),
      contentType: z.string().optional(),
      raw: z.boolean().optional().describe("Return the body exactly as received"),
      includeHeaders: z.boolean().optional(),
      maxChars: z.number().int().optional(),
    },
  },
  tool(async (a: any) => {
    let method = a.method as string | undefined;
    let path = a.path as string | undefined;
    if (a.operationId) {
      const op = spec.byId.get(a.operationId);
      if (!op) throw new Error(`Unknown operationId "${a.operationId}" — use vro_api_search`);
      method = method ?? op.method;
      path = path ?? op.path;
      const missing = (path!.match(/\{([^}]+)\}/g) ?? [])
        .map((m) => m.slice(1, -1))
        .filter((k) => a.pathParams?.[k] === undefined);
      if (missing.length) throw new Error(`Missing pathParams: ${missing.join(", ")} (path ${path})`);
    }
    if (!method || !path) throw new Error("Provide operationId, or method + path");
    const pp = a.pathParams ?? {};
    const resolved = path.replace(/\{([^}]+)\}/g, (_m, k) => {
      if (pp[k] === undefined) throw new Error(`No value for path parameter {${k}}`);
      return k === "**" ? String(pp[k]) : enc(String(pp[k]));
    });
    const r = await vro.request(method, resolved, {
      query: a.query,
      body: a.body,
      headers: a.headers,
      accept: a.accept,
      contentType: a.contentType,
    });
    const body = a.raw ? r.body : flattenInventory(r.body);
    const result: any = { status: r.status, ...(a.includeHeaders || !r.body ? { headers: r.headers } : {}), body };
    if (!r.ok) {
      const op = spec.match(method, resolved);
      if (op) result.hint = `See vro_api_describe("${op.id}") for the expected parameters/body.`;
    }
    const res = out(result, a.maxChars ?? cfg.maxChars);
    if (!r.ok) res.isError = true;
    return res;
  })
);

// ---- workflows

server.registerTool(
  "vro_find_workflows",
  {
    description: "Find Orchestrator workflows by (partial) name. Returns id, name, category, version, description.",
    inputSchema: {
      name: z.string().optional().describe("Partial name; omit to list all"),
      limit: z.number().int().min(1).max(500).optional(),
      startIndex: z.number().int().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { name?: string; limit?: number; startIndex?: number }) => {
    const r = await vro.call("GET", "/workflows", {
      query: {
        conditions: a.name ? `name~${a.name}` : undefined,
        maxResult: a.limit ?? 50,
        startIndex: a.startIndex ?? 0,
      },
    });
    const f = flattenInventory(r.body);
    const items = f.items ?? [];
    return {
      // VCFO 9.x returns total=-1 (no queryCount support); report what came back
      total: typeof f.total === "number" && f.total >= 0 ? f.total : items.length,
      ...(f["last-item-token"] ? { more: "more results exist - raise limit or use startIndex" } : {}),
      items: items.map((i: any) => ({
        id: i.id,
        name: i.name,
        category: i.categoryName,
        version: i.version,
        description: i.description,
      })),
    };
  })
);

server.registerTool(
  "vro_get_workflow",
  {
    description: "Get a workflow's inputs/outputs (names + types), version and description, by id or exact name.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or name"),
      includeContent: z.boolean().optional().describe("Also return the full workflow content (schema, scripts) — can be large"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { workflow: string; includeContent?: boolean }) => {
    const id = await resolveWorkflowId(a.workflow);
    const def = await getWorkflowDef(id);
    if (!a.includeContent) return def;
    const c = await vro.request("GET", `/workflows/${enc(id)}/content`);
    return { ...def, content: c.ok ? c.body : `HTTP ${c.status}` };
  })
);

server.registerTool(
  "vro_run_workflow",
  {
    description:
      "Run a workflow by id or name with plain JSON inputs ({inputName: value}); values are converted to Orchestrator types automatically (string, number, boolean, Date, Properties, Array/x, SecureString, SDK objects given as id). By default waits for completion and returns state, outputs, error and logs.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or name"),
      inputs: jsonObj.optional(),
      wait: z.boolean().optional().describe("Wait for the run to finish (default true)"),
      timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Max wait (default 180)"),
      includeLogs: z.boolean().optional().describe("Include logs even on success (always included on failure)"),
    },
  },
  tool(async (a: { workflow: string; inputs?: Record<string, unknown>; wait?: boolean; timeoutSeconds?: number; includeLogs?: boolean }) => {
    const id = await resolveWorkflowId(a.workflow);
    const def = await getWorkflowDef(id);
    const parameters = buildParameters(def.inputs, a.inputs ?? {});
    const r = await vro.call("POST", `/workflows/${enc(id)}/executions`, { body: { parameters } });
    const b: any = r.body;
    const execId = b?.id ?? r.headers["location"]?.replace(/\/+$/, "").split("/").pop();
    if (!execId) throw new Error(`Workflow started but no execution id was returned (HTTP ${r.status})`);
    if (a.wait === false) return { workflowId: id, executionId: execId, state: b?.state ?? "running" };
    const { exec, timedOut } = await waitForExecution(id, execId, a.timeoutSeconds ?? 180);
    const summary: any = { workflowId: id, ...summarizeExecution(exec) };
    if (timedOut) summary.note = "Still running — check later with vro_get_execution";
    if (STOP_WAITING.has(exec.state)) summary.note = `Execution is '${exec.state}' (user interaction or signal needed)`;
    if (a.includeLogs || exec.state === "failed") summary.logs = await fetchExecutionLogs(id, execId, 200);
    return summary;
  })
);

server.registerTool(
  "vro_get_execution",
  {
    description: "Get a workflow execution's state, outputs and error, optionally with logs. Can also wait for it to finish.",
    inputSchema: {
      workflowId: z.string(),
      executionId: z.string(),
      includeLogs: z.boolean().optional(),
      includeInputs: z.boolean().optional(),
      waitSeconds: z.number().int().min(0).max(3600).optional().describe("Wait up to N seconds for completion"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { workflowId: string; executionId: string; includeLogs?: boolean; includeInputs?: boolean; waitSeconds?: number }) => {
    const exec = a.waitSeconds
      ? (await waitForExecution(a.workflowId, a.executionId, a.waitSeconds)).exec
      : await getExecution(a.workflowId, a.executionId);
    const s: any = summarizeExecution(exec);
    if (a.includeInputs) s.inputs = paramsToObject(pick(exec, "input-parameters", "inputParameters"));
    if (a.includeLogs || exec.state === "failed") s.logs = await fetchExecutionLogs(a.workflowId, a.executionId, 300);
    return s;
  })
);

server.registerTool(
  "vro_list_executions",
  {
    description: "List recent executions of a workflow (id, state, start/end, started by).",
    inputSchema: {
      workflow: z.string().describe("Workflow id or name"),
      limit: z.number().int().min(1).max(200).optional(),
      state: z.string().optional().describe("Filter, e.g. failed | completed | running"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { workflow: string; limit?: number; state?: string }) => {
    const id = await resolveWorkflowId(a.workflow);
    const r = await vro.call("GET", `/workflows/${enc(id)}/executions`, {
      query: { maxResult: a.limit ?? 20, conditions: a.state ? `state=${a.state}` : undefined },
    });
    const f = flattenInventory(r.body);
    return { workflowId: id, total: f.total, items: f.items ?? f };
  })
);

// ---- actions

server.registerTool(
  "vro_find_actions",
  {
    description: "Find Orchestrator actions by partial module or name (e.g. 'getAllVMs', 'com.vmware.library.vc'). Returns fqn module/name and id.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { query: string; limit?: number }) => {
    const r = await vro.call("GET", "/actions");
    const items = flattenInventory(r.body)?.items ?? [];
    const q = a.query.toLowerCase();
    const hits = items.filter((i: any) =>
      [i.fqn, i.name, i.module, i.description].some((x: any) => x && String(x).toLowerCase().includes(q))
    );
    return {
      total: hits.length,
      items: hits.slice(0, a.limit ?? 50).map((i: any) => ({
        fqn: i.fqn ?? `${i.module}/${i.name}`,
        id: i.id,
        version: i.version,
        description: i.description,
      })),
    };
  })
);

server.registerTool(
  "vro_get_action",
  {
    description: "Get an action's script, inputs and return type. Reference as 'module/name' or id.",
    inputSchema: { action: z.string() },
    annotations: { readOnlyHint: true },
  },
  tool(async (a: { action: string }) => summarizeAction(await getAction(a.action)))
);

server.registerTool(
  "vro_run_action",
  {
    description:
      "Execute an action synchronously with plain JSON inputs ({inputName: value}) and return its result (converted to plain JSON), error with line number, and logs.",
    inputSchema: {
      action: z.string().describe("'module/name' or action id"),
      inputs: jsonObj.optional(),
    },
  },
  tool(async (a: { action: string; inputs?: Record<string, unknown> }) => {
    const action = await getAction(a.action);
    return executeAction(action, a.inputs ?? {});
  })
);

const paramDefSchema = z.object({ name: z.string(), type: z.string(), description: z.string().optional() });

server.registerTool(
  "vro_save_action",
  {
    description:
      "Create or update an action (upsert by module/name). Script must be plain ES5 JavaScript (no arrow functions, let/const, template literals, etc.) — Orchestrator runs Rhino. Omitted inputs/returnType keep the existing ones on update.",
    inputSchema: {
      module: z.string().describe("e.g. com.mayank.lab"),
      name: z.string(),
      script: z.string(),
      inputs: z.array(paramDefSchema).optional(),
      returnType: z.string().optional().describe("e.g. string, Properties, Array/string, VC:VirtualMachine, void"),
      description: z.string().optional(),
    },
  },
  tool(async (a: any) => saveAction(a))
);

server.registerTool(
  "vro_run_script",
  {
    description:
      "Run an ad-hoc JavaScript snippet on Orchestrator — for prototyping and quick checks. Creates a temporary action, executes it with the given inputs (available as variables), returns the 'return' value + System.log output, then deletes the action. Script must be plain ES5 (Rhino): var, function(){}, no arrow functions/let/const/template literals.",
    inputSchema: {
      script: z.string().describe("Body of the function. Use `return x;` to return a value."),
      inputs: jsonObj.optional().describe("Variables passed into the script"),
      inputTypes: z.record(z.string(), z.string()).optional().describe("Optional explicit types, e.g. {vm: 'VC:VirtualMachine'}"),
      returnType: z.string().optional().describe("Default 'Any'"),
      keepAction: z.boolean().optional().describe("Don't delete the temp action afterwards (to inspect it)"),
    },
  },
  tool(async (a: { script: string; inputs?: Record<string, unknown>; inputTypes?: Record<string, string>; returnType?: string; keepAction?: boolean }) => {
    const inputs = a.inputs ?? {};
    const defs: ParamDef[] = Object.entries(inputs).map(([name, v]) => ({
      name,
      type:
        a.inputTypes?.[name] ??
        (typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : typeof v === "string" ? "string" : Array.isArray(v) ? "Array/Any" : "Properties"),
    }));
    const name = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const saved = await saveAction({
      module: cfg.scratchModule,
      name,
      script: a.script,
      inputs: defs,
      returnType: a.returnType ?? "Any",
      description: "Temporary action created by vcf-orchestrator MCP (vro_run_script)",
    });
    try {
      const action = await getAction(`${cfg.scratchModule}/${name}`);
      const result = await executeAction(action, inputs);
      return a.keepAction ? { ...result, action: `${cfg.scratchModule}/${name}` } : result;
    } finally {
      if (!a.keepAction && saved.action.id) {
        await vro.request("DELETE", `/actions/${enc(saved.action.id)}`, { query: { force: true } }).catch(() => undefined);
      }
    }
  })
);

// ---------------------------------------------------------------- start

// ---- workflow authoring

function categoryLinks(body: any, rel: string): { id: string; name: string }[] {
  const links: any[] = body?.relations?.link ?? body?.link ?? [];
  return links
    .filter((l) => (rel === "*" || l.rel === rel) && Array.isArray(l.attributes))
    .map((l) => {
      const o: Record<string, string> = {};
      for (const a of l.attributes) o[a.name] = a.value;
      return { id: o.id, name: o.name, type: o.type };
    })
    .filter((c: any) => c.id && (!c.type || c.type === "WorkflowCategory"));
}

/** Ensure a folder path like "mbcom/Onboarding" exists (walks the tree from the roots); returns the leaf id */
async function ensureWorkflowFolder(folderPath: string): Promise<string> {
  const parts = folderPath.split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("folder must be a path like 'Lab/Onboarding'");
  const roots = await vro.call("GET", "/categories", { query: { categoryType: "WorkflowCategory", isRoot: true } });
  let children = categoryLinks(roots.body, "*");
  let parentId: string | undefined;
  for (const part of parts) {
    let hit = children.find((c) => c.name === part) ?? children.find((c) => c.name?.toLowerCase() === part.toLowerCase());
    if (!hit) {
      const body = { name: part, type: "WorkflowCategory", description: "Created by vcf-orchestrator MCP" };
      const r = await vro.call("POST", parentId ? `/categories/${enc(parentId)}` : "/categories", { body });
      const b: any = r.body;
      if (!b?.id) throw new Error(`Created folder "${part}" but got no id back (HTTP ${r.status})`);
      hit = { id: b.id, name: part };
    }
    parentId = hit.id;
    const cur = await vro.call("GET", `/categories/${enc(parentId)}`);
    children = categoryLinks(cur.body, "down");
  }
  return parentId!;
}

async function findWorkflowInCategory(name: string, categoryId: string): Promise<string | undefined> {
  const r = await vro.call("GET", "/workflows", { query: { conditions: `name=${name}`, maxResult: 50 } });
  const items: any[] = flattenInventory(r.body)?.items ?? [];
  const exact = items.filter((i) => i.name === name);
  const inCat = exact.filter((i) => !i.categoryId || i.categoryId === categoryId);
  return (inCat[0] ?? (exact.length === 1 ? exact[0] : undefined))?.id;
}

const wfParamSchema = z.object({
  name: z.string(),
  type: z.string().describe("string, number, boolean, Properties, Array/string, VRA:Host, VC:VirtualMachine, ..."),
  description: z.string().optional(),
  default: z.any().optional().describe("Default (string/number/boolean/Array of strings)"),
});

const wfStepSchema = z.object({
  id: z.string().describe("Unique step id, used by next/ifTrue/ifFalse"),
  type: z.enum(["script", "action", "decision", "end"]).optional().describe("Default: script (or action if 'action' is set)"),
  name: z.string().optional().describe("Display name on the canvas"),
  description: z.string().optional(),
  script: z.string().optional().describe("ES5 script. Decisions must `return` a boolean."),
  action: z.string().optional().describe("Action step: 'module/actionName'"),
  args: z.record(z.string(), z.string()).optional().describe("Action step: ordered {actionParam: workflowVariable}"),
  resultTo: z.string().optional().describe("Action step: variable receiving the return value"),
  in: z.array(z.string()).optional().describe("Variables the step reads (in-bindings)"),
  out: z.array(z.string()).optional().describe("Variables the step writes (out-bindings) — outputs/attributes only"),
  next: z.string().optional().describe("Next step id (default: following step, or end)"),
  ifTrue: z.string().optional(),
  ifFalse: z.string().optional(),
});

server.registerTool(
  "vro_save_workflow",
  {
    description:
      "Create or update (upsert by name + folder) an Orchestrator workflow from a compact spec: inputs, outputs, attributes and ordered steps (script tasks, action calls, decisions, ends). Builds the schema, creates the folder path if missing, and validates. Scripts must be plain ES5. Steps flow in array order unless next/ifTrue/ifFalse say otherwise. Set dryRun to only return the generated XML.",
    inputSchema: {
      folder: z.string().describe("Workflow folder path, e.g. 'mbcom/Onboarding' (created if missing)"),
      name: z.string(),
      description: z.string().optional(),
      version: z.string().optional(),
      inputs: z.array(wfParamSchema).optional(),
      outputs: z.array(wfParamSchema).optional(),
      attributes: z.array(wfParamSchema).optional(),
      steps: z.array(wfStepSchema),
      dryRun: z.boolean().optional(),
    },
  },
  tool(async (a: WfSpec & { folder: string; dryRun?: boolean }) => {
    const errs = validateSpec(a);
    if (errs.length) throw new Error("Invalid workflow spec:\n  " + errs.join("\n  "));
    if (a.dryRun) return { xml: buildWorkflowXml(a, { id: "00000000-0000-0000-0000-000000000000" }) };

    const categoryId = await ensureWorkflowFolder(a.folder);
    let id = await findWorkflowInCategory(a.name, categoryId);
    const created = !id;
    if (!id) {
      const r = await vro.call("POST", "/workflows", {
        body: { name: a.name, description: a.description ?? "", "category-id": categoryId },
      });
      const b: any = r.body;
      id = b?.id ?? r.headers["location"]?.replace(/\/+$/, "").split("/").pop();
      if (!id) throw new Error(`Workflow created but no id returned (HTTP ${r.status}): ${JSON.stringify(b)?.slice(0, 300)}`);
    }
    const xml = buildWorkflowXml(a, { id: id! });
    await vro.call("PUT", `/workflows/${enc(id!)}/content`, { body: xml, contentType: "application/xml" });

    const v = await vro.request("GET", `/workflows/${enc(id!)}/validate`);
    const def = await getWorkflowDef(id!);
    return {
      created,
      workflowId: id,
      folder: a.folder,
      name: def.name,
      version: def.version,
      inputs: def.inputs,
      outputs: def.outputs,
      validation: v.ok ? v.body ?? "ok" : `HTTP ${v.status}: ${JSON.stringify(v.body)?.slice(0, 800)}`,
    };
  })
);

server.registerTool(
  "vro_delete_workflow",
  {
    description: "Delete a workflow by id or exact name.",
    inputSchema: { workflow: z.string(), force: z.boolean().optional() },
    annotations: { destructiveHint: true },
  },
  tool(async (a: { workflow: string; force?: boolean }) => {
    const id = await resolveWorkflowId(a.workflow);
    await vro.call("DELETE", `/workflows/${enc(id)}`, { query: { force: a.force ?? false } });
    return { deleted: id };
  })
);

// When the client goes away, stdout writes fail with EPIPE — exit quietly instead of crashing.
for (const s of [process.stdout, process.stdin]) {
  s.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED" || err?.code === "ECONNRESET") process.exit(0);
    console.error("[vcf-orchestrator-mcp] stream error:", err);
  });
}
process.stdin.on("end", () => process.exit(0));
process.on("unhandledRejection", (r) => console.error("[vcf-orchestrator-mcp] unhandled rejection:", r));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[vcf-orchestrator-mcp] ready — ${cfg.url}${cfg.apiBase}, auth=${cfg.authMode}, spec ops=${spec.ops.length}${cfg.insecure ? ", TLS verify OFF" : ""}`
);
