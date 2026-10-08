/**
 * Build Orchestrator workflow schema XML from a compact spec.
 *
 * Spec example:
 * {
 *   name: "Onboard VMs by Name",
 *   inputs:  [{ name: "vmNames", type: "Array/string", description: "...", default: [...] }],
 *   outputs: [{ name: "planLink", type: "string" }],
 *   attributes: [{ name: "projectId", type: "string" }],
 *   steps: [
 *     { id: "resolve", name: "Resolve IDs", script: "...", in: ["vraHost"], out: ["projectId"] },
 *     { id: "dry", type: "decision", name: "Dry run?", script: "return dryRun == true;", in: ["dryRun"],
 *       ifTrue: "report", ifFalse: "execute" },
 *     { id: "done", type: "end" }
 *   ]
 * }
 * Steps run in array order unless `next` (script) or `ifTrue`/`ifFalse` (decision) point elsewhere.
 * A script/action step with no `next` that is last in the list (or followed only by an explicit end) goes to the end.
 */

export interface WfParam {
  name: string;
  type: string;
  description?: string;
  default?: unknown;
}

export interface WfStep {
  id: string;
  type?: "script" | "action" | "decision" | "end";
  name?: string;
  description?: string;
  /** script / decision body */
  script?: string;
  /** action step: "module/actionName"; args map actionParam -> workflow variable; resultTo -> variable */
  action?: string;
  args?: Record<string, string>;
  resultTo?: string;
  in?: string[];
  out?: string[];
  next?: string;
  ifTrue?: string;
  ifFalse?: string;
}

export interface WfSpec {
  name: string;
  description?: string;
  version?: string;
  inputs?: WfParam[];
  outputs?: WfParam[];
  attributes?: WfParam[];
  steps: WfStep[];
}

const cdata = (s: string) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const attr = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Default values in the classic workflow XML value encoding */
function encodeDefault(type: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = type.toLowerCase();
  if (t === "string" || t === "securestring") return `${cdata(String(v))}`;
  if (t === "number") return cdata(String(Number(v)));
  if (t === "boolean") return cdata(v === true || v === "true" ? "true" : "false");
  if (t === "array/string" && Array.isArray(v)) {
    return cdata("#{" + v.map((x) => "#string#" + String(x).replace(/[#{}]/g, (c) => "\\" + c) + "#").join(";") + "}#");
  }
  return undefined;
}

export function validateSpec(spec: WfSpec): string[] {
  const errs: string[] = [];
  if (!spec.name) errs.push("name is required");
  if (!Array.isArray(spec.steps) || !spec.steps.length) errs.push("steps must be a non-empty array");
  const vars = new Map<string, string>();
  const kinds = new Map<string, string>();
  for (const [kind, list] of [
    ["input", spec.inputs],
    ["output", spec.outputs],
    ["attribute", spec.attributes],
  ] as const) {
    for (const p of list ?? []) {
      if (!p.name || !p.type) errs.push(`${kind} needs name and type: ${JSON.stringify(p)}`);
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.name)) errs.push(`${kind} name "${p.name}" is not a valid identifier`);
      if (vars.has(p.name)) errs.push(`variable "${p.name}" is declared more than once`);
      vars.set(p.name, p.type);
      kinds.set(p.name, kind);
    }
  }
  const ids = new Set<string>();
  for (const s of spec.steps ?? []) {
    if (!s.id) errs.push(`every step needs an id: ${JSON.stringify(s).slice(0, 80)}`);
    if (ids.has(s.id)) errs.push(`duplicate step id "${s.id}"`);
    ids.add(s.id);
  }
  for (const s of spec.steps ?? []) {
    const type = stepType(s);
    for (const ref of [s.next, s.ifTrue, s.ifFalse]) if (ref && !ids.has(ref)) errs.push(`step "${s.id}" points to unknown step "${ref}"`);
    if (type === "decision" && (!s.ifTrue || !s.ifFalse)) errs.push(`decision "${s.id}" needs ifTrue and ifFalse`);
    if (type === "script" && !s.script) errs.push(`step "${s.id}" has no script`);
    if (type === "action" && !/^[^/]+\/[^/]+$/.test(s.action ?? "")) errs.push(`step "${s.id}": action must be "module/name"`);
    for (const v of bindingsIn(s)) if (!vars.has(v)) errs.push(`step "${s.id}" reads undeclared variable "${v}"`);
    for (const v of bindingsOut(s)) {
      if (!vars.has(v)) errs.push(`step "${s.id}" writes undeclared variable "${v}"`);
      else if (kinds.get(v) === "input") errs.push(`step "${s.id}" writes input "${v}" — inputs are read-only; use an attribute`);
    }
  }
  return errs;
}

function stepType(s: WfStep): "script" | "action" | "decision" | "end" {
  if (s.type) return s.type;
  if (s.action) return "action";
  return "script";
}

function bindingsIn(s: WfStep): string[] {
  if (stepType(s) === "action") return [...new Set([...(s.in ?? []), ...Object.values(s.args ?? {})])];
  return s.in ?? [];
}
function bindingsOut(s: WfStep): string[] {
  if (stepType(s) === "action") return [...new Set([...(s.out ?? []), ...(s.resultTo ? [s.resultTo] : [])])];
  return s.out ?? [];
}

function actionScript(s: WfStep): string {
  const [module, name] = s.action!.split("/");
  const args = Object.values(s.args ?? {}).join(", ");
  const call = `System.getModule("${module}").${name}(${args})`;
  return s.resultTo ? `${s.resultTo} = ${call};` : `${call};`;
}

export function buildWorkflowXml(spec: WfSpec, opts: { id: string; categoryId?: string; rootAttrs?: Record<string, string> }): string {
  const errs = validateSpec(spec);
  if (errs.length) throw new Error("Invalid workflow spec:\n  " + errs.join("\n  "));

  const vars = new Map<string, string>();
  for (const p of [...(spec.inputs ?? []), ...(spec.outputs ?? []), ...(spec.attributes ?? [])]) vars.set(p.name, p.type);

  // item0 = implicit end; real steps item1..n
  const itemName = new Map<string, string>();
  let n = 1;
  for (const s of spec.steps) itemName.set(s.id, stepType(s) === "end" ? `item${n++}` : `item${n++}`);
  const IMPLICIT_END = "item0";

  const nextOf = (i: number): string => {
    const s = spec.steps[i];
    if (s.next) return itemName.get(s.next)!;
    // fall through to the following step, skipping nothing
    if (i + 1 < spec.steps.length) return itemName.get(spec.steps[i + 1].id)!;
    return IMPLICIT_END;
  };

  // A step that follows a decision in array order is only reached via explicit links; fine.
  const usesImplicitEnd = spec.steps.some((s, i) => {
    const t = stepType(s);
    return (t === "script" || t === "action") && !s.next && i === spec.steps.length - 1;
  });

  const bindXml = (tag: "in-binding" | "out-binding", names: string[]) =>
    names.length
      ? `<${tag}>` + names.map((v) => `<bind name="${attr(v)}" type="${attr(vars.get(v)!)}" export-name="${attr(v)}"/>`).join("") + `</${tag}>`
      : `<${tag}/>`;

  const items: string[] = [];
  const X0 = 140, DX = 180, Y = 80;
  spec.steps.forEach((s, i) => {
    const t = stepType(s);
    const nm = itemName.get(s.id)!;
    const pos = `<position y="${Y + (t === "end" ? 60 : 0)}" x="${X0 + i * DX}"/>`;
    const disp = `<display-name>${cdata(s.name ?? s.id)}</display-name>`;
    const desc = s.description ? `<description>${cdata(s.description)}</description>` : "";
    if (t === "end") {
      items.push(`<workflow-item name="${nm}" type="end" end-mode="0" comparator="0">${desc}${pos}</workflow-item>`);
    } else if (t === "decision") {
      items.push(
        `<workflow-item name="${nm}" out-name="${itemName.get(s.ifTrue!)}" alt-out-name="${itemName.get(s.ifFalse!)}" type="custom-condition" comparator="0">` +
          disp +
          `<script encoded="false">${cdata(s.script!)}</script>` +
          bindXml("in-binding", bindingsIn(s)) +
          desc +
          pos +
          `</workflow-item>`
      );
    } else {
      const script = t === "action" ? actionScript(s) : s.script!;
      const mod = t === "action" ? ` script-module="${attr(s.action!)}"` : "";
      items.push(
        `<workflow-item name="${nm}" out-name="${nextOf(i)}" type="task"${mod} comparator="0">` +
          disp +
          `<script encoded="false">${cdata(script)}</script>` +
          bindXml("in-binding", bindingsIn(s)) +
          bindXml("out-binding", bindingsOut(s)) +
          desc +
          pos +
          `</workflow-item>`
      );
    }
  });
  if (usesImplicitEnd) {
    items.unshift(`<workflow-item name="${IMPLICIT_END}" type="end" end-mode="0" comparator="0"><position y="${Y + 60}" x="${X0 + spec.steps.length * DX}"/></workflow-item>`);
  }

  const paramXml = (p: WfParam) =>
    `<param name="${attr(p.name)}" type="${attr(p.type)}">${p.description ? `<description>${cdata(p.description)}</description>` : ""}</param>`;
  const attribXml = (p: WfParam) => {
    const v = encodeDefault(p.type, p.default);
    return (
      `<attrib name="${attr(p.name)}" type="${attr(p.type)}" read-only="false">` +
      (v ? `<value encoded="n">${v}</value>` : "") +
      (p.description ? `<description>${cdata(p.description)}</description>` : "") +
      `</attrib>`
    );
  };

  // Input defaults via presentation (honoured by the generated input form)
  const pParams = (spec.inputs ?? [])
    .map((p) => {
      const v = encodeDefault(p.type, p.default);
      return v ? `<p-param name="${attr(p.name)}"><desc>${cdata(p.description ?? p.name)}</desc><p-qual kind="static" name="defaultValue" type="${attr(p.type)}">${v}</p-qual></p-param>` : "";
    })
    .join("");

  const root = itemName.get(spec.steps[0].id)!;
  const extra = Object.entries(opts.rootAttrs ?? {})
    .filter(([k]) => !["root-name", "id", "version", "object-name", "xmlns", "xmlns:ns2"].includes(k))
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<schema-workflow xmlns:ns2="http://www.vmware.com/vco" root-name="${root}" object-name="workflow:name=generic" id="${attr(opts.id)}" version="${attr(spec.version ?? "1.0.0")}" api-version="6.0.0" restartMode="1" resumeFromFailedMode="0" editor-version="2.0"${extra}>` +
    `<display-name>${cdata(spec.name)}</display-name>` +
    `<description>${cdata(spec.description ?? "")}</description>` +
    `<position y="50" x="100"/>` +
    `<input>${(spec.inputs ?? []).map(paramXml).join("")}</input>` +
    `<output>${(spec.outputs ?? []).map(paramXml).join("")}</output>` +
    (spec.attributes ?? []).map(attribXml).join("") +
    items.join("") +
    `<presentation>${pParams}</presentation>` +
    `</schema-workflow>`
  );
}
