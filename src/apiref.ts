/**
 * Orchestrator scripting API reference from modernvroapi.in (static JSON API, no auth):
 *   {base}/classes.json                         class name -> [{ plugin, url }]
 *   {base}/plugins/{pluginId}/{Class}.json       attributes, constructors, methods (with signatures)
 * Used by vro_sdk_lookup and by the automatic check that runs when scripts are saved.
 * Everything is cached on disk so the site is hit rarely, and every failure degrades to "skipped".
 */
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetch } from "undici";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

export interface RefMethod {
  name: string;
  signature?: string;
  parameters?: string;
  returnType?: string;
  description?: string;
}
export interface RefClass {
  plugin?: string;
  pluginName?: string;
  name: string;
  description?: string;
  attributes?: { name: string; type?: string; description?: string }[];
  constructors?: unknown[];
  methods?: RefMethod[];
  docUrl?: string;
}
type ClassIndex = Record<string, { plugin: string; url: string }[]>;

export interface ApiRefOptions {
  baseUrl: string; // e.g. https://modernvroapi.in/api/v1
  enabled: boolean;
  cacheDir?: string;
  ttlHours?: number;
  timeoutMs?: number;
}

// Plain JavaScript (Rhino) globals: never vRO classes, never warned about
const JS_GLOBALS = new Set([
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Function", "Infinity", "NaN",
  "undefined", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "escape", "unescape", "eval", "arguments", "Packages", "java", "javax", "importClass",
  "importPackage", "JavaImporter",
]);

const editDistance = (a: string, b: string): number => {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

function closest(name: string, candidates: string[], max = 3): string[] {
  const lower = name.toLowerCase();
  const prefix = lower.slice(0, Math.min(6, lower.length));
  return candidates
    .map((c) => {
      const cl = c.toLowerCase();
      if (cl.includes(lower) || lower.includes(cl)) return { c, s: 0 };
      const caps = (x: string) => x.replace(/[^A-Z]/g, "");
      if (caps(name).length >= 2 && caps(c) === caps(name) && cl.startsWith(lower.slice(0, 3))) return { c, s: 0 };
      if (prefix.length >= 4 && cl.startsWith(prefix)) return { c, s: 1 };
      return { c, s: editDistance(name, c) };
    })
    .filter((x) => x.s <= Math.max(2, Math.floor(name.length / 3)))
    .sort((x, y) => x.s - y.s || x.c.length - y.c.length)
    .slice(0, max)
    .map((x) => x.c);
}

/** "string text, number count" -> 2 ; "" -> 0 */
export function paramCount(params: string | undefined): number {
  const p = (params ?? "").trim();
  if (!p || p === "void") return 0;
  let depth = 0;
  let n = 1;
  for (const ch of p) {
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "]") depth--;
    else if (ch === "," && depth === 0) n++;
  }
  return n;
}

/** Orchestrator type ("VC:VirtualMachine", "Array/VC:Datastore", "REST:RESTHost") -> candidate scripting class names */
export function typeToClassCandidates(type: string | undefined): string[] {
  if (!type) return [];
  let t = type.trim().replace(/^Array\//i, "");
  const m = t.match(/^([A-Za-z0-9_]+):(.+)$/);
  if (!m) return [t];
  const [, prefix, name] = m;
  const cap = prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();
  return [...new Set([name, `${cap}${name}`, `${prefix}${name}`, `${prefix.toUpperCase()}${name}`])];
}

export class ApiReference {
  private index?: ClassIndex;
  private classCache = new Map<string, RefClass | null>();
  private disabledReason?: string;

  constructor(private opts: ApiRefOptions) {
    if (!opts.enabled) this.disabledReason = "disabled (VRO_APIREF=off)";
  }

  get base() {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  private cacheFile(url: string) {
    const dir = this.opts.cacheDir ?? path.join(homedir(), ".vcf-orchestrator-mcp", "apiref-cache");
    return path.join(dir, createHash("sha1").update(url).digest("hex") + ".json");
  }

  private async getJson<T>(url: string): Promise<T> {
    const file = this.cacheFile(url);
    const ttl = (this.opts.ttlHours ?? 72) * 3600 * 1000;
    let stale: T | undefined;
    try {
      const age = Date.now() - statSync(file).mtimeMs;
      const cached = JSON.parse(readFileSync(file, "utf8")) as T;
      if (age < ttl) return cached;
      stale = cached;
    } catch {
      /* no cache yet */
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = (await res.json()) as T;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data));
      } catch {
        /* cache is best effort */
      }
      return data;
    } catch (e) {
      if (stale !== undefined) return stale; // offline: use the old copy
      throw e;
    }
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.disabledReason) return { ok: false, reason: this.disabledReason };
    try {
      await this.classIndex();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: `modernvroapi.in not reachable (${e?.message ?? e})` };
    }
  }

  async classIndex(): Promise<ClassIndex> {
    if (this.disabledReason) throw new Error(this.disabledReason);
    if (!this.index) this.index = await this.getJson<ClassIndex>(`${this.base}/classes.json`);
    return this.index;
  }

  async getClass(name: string, plugin?: string): Promise<RefClass | null> {
    const key = `${plugin ?? ""}|${name}`;
    if (this.classCache.has(key)) return this.classCache.get(key)!;
    const idx = await this.classIndex();
    const entries = idx[name];
    let result: RefClass | null = null;
    if (entries?.length) {
      const entry = (plugin && entries.find((e) => e.plugin === plugin)) || entries[0];
      result = await this.getJson<RefClass>(entry.url);
    }
    this.classCache.set(key, result);
    return result;
  }

  async findClasses(query: string, limit = 10): Promise<{ name: string; plugins: string[] }[]> {
    const idx = await this.classIndex();
    const q = query.toLowerCase();
    const names = Object.keys(idx);
    const hits = names.filter((n) => n.toLowerCase().includes(q));
    const ranked = (hits.length ? hits : closest(query, names, limit)).sort(
      (a, b) => Number(b.toLowerCase() === q) - Number(a.toLowerCase() === q) || a.length - b.length
    );
    return ranked.slice(0, limit).map((n) => ({ name: n, plugins: idx[n].map((e) => e.plugin) }));
  }

  async classNames(): Promise<string[]> {
    return Object.keys(await this.classIndex());
  }
}

// ---------------------------------------------------------------- script check

export interface CheckFinding {
  line?: number;
  kind: "not-es5" | "syntax" | "unknown-class" | "unknown-method" | "argument-count" | "unknown-property";
  message: string;
  suggestions?: string[];
  signatures?: string[];
}
export interface CheckResult {
  checked: boolean;
  source?: string;
  skipped?: string;
  es5: boolean;
  findings: CheckFinding[];
  classesChecked?: string[];
}

interface CallSite {
  line: number;
  objectName: string; // identifier the member is accessed on
  member: string;
  args: number;
  isCall: boolean;
}

/**
 * Check one script (action body or workflow task) against plain ES5 and the API reference.
 * typedVars maps variable names to Orchestrator types (inputs, attributes), so calls on them are checked too.
 */
export async function checkScript(
  ref: ApiReference,
  script: string,
  typedVars: Record<string, string> = {},
  label?: string
): Promise<CheckResult> {
  const findings: CheckFinding[] = [];
  const at = (line?: number) => (label ? `${label}${line ? ` line ${line}` : ""}` : line ? `line ${line}` : "");

  // 1. ES5 syntax (Orchestrator runs Rhino)
  let ast: acorn.Node | undefined;
  let es5 = true;
  const parse = (ecmaVersion: acorn.ecmaVersion) =>
    acorn.parse(script, { ecmaVersion, allowReturnOutsideFunction: true, locations: true, sourceType: "script" });
  try {
    ast = parse(5);
  } catch (e: any) {
    es5 = false;
    try {
      ast = parse("latest");
      findings.push({ line: e.loc?.line, kind: "not-es5", message: `${at(e.loc?.line)}: not ES5 (${e.message.replace(/\s*\(\d+:\d+\)$/, "")}). Orchestrator runs Rhino: use var, function () {}, string concatenation.` });
    } catch (e2: any) {
      findings.push({ line: e2.loc?.line, kind: "syntax", message: `${at(e2.loc?.line)}: syntax error: ${e2.message}` });
      return { checked: false, es5: false, findings, skipped: "script does not parse" };
    }
  }

  // 2. API reference
  const avail = await ref.available();
  if (!avail.ok) return { checked: false, es5, findings, skipped: avail.reason };

  const declared = new Set<string>(Object.keys(typedVars));
  const sites: CallSite[] = [];
  const news: { line: number; name: string; args: number }[] = [];
  walk.full(ast!, (node: any) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") declared.add(node.id.name);
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id) declared.add(node.id.name);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression")
      for (const p of node.params ?? []) if (p.type === "Identifier") declared.add(p.name);
    if (node.type === "CatchClause" && node.param?.type === "Identifier") declared.add(node.param.name);
    if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") declared.add(node.left.name);
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.type === "Identifier") {
      sites.push({ line: node.loc.start.line, objectName: node.callee.object.name, member: node.callee.property.name, args: node.arguments.length, isCall: true });
    }
    if (node.type === "NewExpression" && node.callee.type === "Identifier") {
      news.push({ line: node.loc.start.line, name: node.callee.name, args: node.arguments.length });
    }
  });

  const names = await ref.classNames();
  const known = new Set(names);
  const checked = new Set<string>();

  const resolveClass = async (objectName: string): Promise<RefClass | null | undefined> => {
    // a typed input/attribute: check its scripting class
    if (typedVars[objectName]) {
      for (const c of typeToClassCandidates(typedVars[objectName])) if (known.has(c)) return ref.getClass(c);
      return undefined; // type not in the reference (string, Properties as JS, ...): nothing to check
    }
    if (declared.has(objectName)) return undefined; // local variable of unknown type
    if (JS_GLOBALS.has(objectName)) return undefined;
    if (known.has(objectName)) return ref.getClass(objectName);
    return null; // looks like a global class, but the reference doesn't have it
  };

  const reportedUnknown = new Set<string>();
  for (const s of sites) {
    const cls = await resolveClass(s.objectName);
    if (cls === undefined) continue;
    if (cls === null) {
      if (/^[A-Z]/.test(s.objectName) && !reportedUnknown.has(s.objectName)) {
        reportedUnknown.add(s.objectName);
        findings.push({
          line: s.line,
          kind: "unknown-class",
          message: `${at(s.line)}: "${s.objectName}" is not a declared variable and not a class on modernvroapi.in`,
          suggestions: closest(s.objectName, names),
        });
      }
      continue;
    }
    checked.add(cls.name);
    const methods = cls.methods ?? [];
    const overloads = methods.filter((m) => m.name === s.member);
    if (!overloads.length) {
      const attr = (cls.attributes ?? []).find((x) => x.name === s.member);
      if (attr) continue; // calling a function-valued attribute is unusual but not ours to judge
      findings.push({
        line: s.line,
        kind: "unknown-method",
        message: `${at(s.line)}: ${cls.name} has no method "${s.member}"${typedVars[s.objectName] ? ` (${s.objectName} is ${typedVars[s.objectName]})` : ""}`,
        suggestions: closest(s.member, [...new Set(methods.map((m) => m.name))]),
      });
      continue;
    }
    if (!overloads.some((m) => paramCount(m.parameters) === s.args)) {
      findings.push({
        line: s.line,
        kind: "argument-count",
        message: `${at(s.line)}: ${cls.name}.${s.member} called with ${s.args} argument(s); documented: ${overloads.map((m) => paramCount(m.parameters)).join(" or ")}`,
        signatures: overloads.map((m) => m.signature ?? `${cls.name}.${m.name}(${m.parameters ?? ""}): ${m.returnType ?? "void"}`),
      });
    }
  }

  for (const n of news) {
    if (declared.has(n.name) || JS_GLOBALS.has(n.name)) continue;
    if (known.has(n.name)) {
      checked.add(n.name);
      continue;
    }
    if (!reportedUnknown.has(n.name)) {
      reportedUnknown.add(n.name);
      findings.push({
        line: n.line,
        kind: "unknown-class",
        message: `${at(n.line)}: new ${n.name}(...): class not found on modernvroapi.in`,
        suggestions: closest(n.name, names),
      });
    }
  }

  return { checked: true, source: ref.base, es5, findings, classesChecked: [...checked].sort() };
}

/** Merge several script checks (e.g. one per workflow task) into one summary */
export function mergeChecks(results: CheckResult[], saved = true): CheckResult & { summary: string } {
  const findings = results.flatMap((r) => r.findings);
  const skipped = results.find((r) => r.skipped)?.skipped;
  const checked = results.some((r) => r.checked);
  const es5 = results.every((r) => r.es5);
  const classes = [...new Set(results.flatMap((r) => r.classesChecked ?? []))].sort();
  const summary = findings.length
    ? `${findings.length} issue(s) found.${saved ? " The save went through; fix these and save again." : ""}`
    : checked
      ? "No issues: ES5 and all checked classes/methods match modernvroapi.in."
      : `Not checked against modernvroapi.in${skipped ? `: ${skipped}` : ""}.${es5 ? " ES5 syntax is fine." : ""}`;
  return { checked, es5, findings, classesChecked: classes, ...(skipped && !checked ? { skipped } : {}), source: results.find((r) => r.source)?.source, summary };
}
