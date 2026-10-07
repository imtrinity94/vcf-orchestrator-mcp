import { readFileSync } from "node:fs";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface OpParam {
  name: string;
  in: string;
  required: boolean;
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  params: OpParam[];
  hasBody: boolean;
  raw: any;
}

function stripHtml(s: string | undefined): string {
  return (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export class SpecIndex {
  doc: any;
  ops: Operation[] = [];
  byId = new Map<string, Operation>();
  title: string;
  version: string;

  constructor(file: string) {
    this.doc = JSON.parse(readFileSync(file, "utf8"));
    this.title = this.doc?.info?.title ?? "Orchestrator API";
    this.version = this.doc?.info?.version ?? "";
    for (const [p, item] of Object.entries<any>(this.doc.paths ?? {})) {
      const shared = item.parameters ?? [];
      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;
        const id = op.operationId ?? `${m}_${p.replace(/[^a-zA-Z0-9]+/g, "_")}`;
        const params: OpParam[] = [...shared, ...(op.parameters ?? [])].map((x: any) => {
          const prm = x.$ref ? this.ref(x.$ref) : x;
          const sch = prm.schema ?? {};
          return {
            name: prm.name,
            in: prm.in,
            required: !!prm.required,
            type: sch.type === "array" ? `array<${sch.items?.type ?? "object"}>` : sch.type,
            description: stripHtml(prm.description) || undefined,
            default: sch.default,
            enum: sch.enum,
          };
        });
        const o: Operation = {
          id,
          method: m.toUpperCase(),
          path: p,
          summary: stripHtml(op.summary),
          description: stripHtml(op.description),
          tags: op.tags ?? [],
          params,
          hasBody: !!op.requestBody,
          raw: op,
        };
        this.ops.push(o);
        this.byId.set(id, o);
      }
    }
  }

  ref(r: string): any {
    if (!r.startsWith("#/")) return {};
    return r
      .slice(2)
      .split("/")
      .reduce((acc: any, k) => acc?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], this.doc);
  }

  tags(): { tag: string; count: number }[] {
    const m = new Map<string, number>();
    for (const o of this.ops) for (const t of o.tags.length ? o.tags : ["(untagged)"]) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }

  search(query: string, opts: { method?: string; tag?: string; limit?: number } = {}) {
    const q = tokens(query);
    const qRaw = query.toLowerCase().trim();
    const scored: { op: Operation; score: number }[] = [];
    for (const op of this.ops) {
      if (opts.method && op.method !== opts.method.toUpperCase()) continue;
      if (opts.tag && !op.tags.some((t) => t.toLowerCase().includes(opts.tag!.toLowerCase()))) continue;
      const idT = tokens(op.id);
      const pathT = tokens(op.path);
      const sumT = tokens(op.summary);
      const tagT = op.tags.flatMap(tokens);
      const descT = tokens(op.description.slice(0, 600));
      let score = 0;
      for (const t of q) {
        const hit = (arr: string[]) => arr.some((x) => x === t || x.startsWith(t) || (t.length > 4 && x.includes(t)));
        if (hit(idT)) score += 4;
        if (hit(pathT)) score += 3;
        if (hit(sumT)) score += 3;
        if (hit(tagT)) score += 2;
        if (hit(descT)) score += 1;
      }
      if (qRaw && (op.path.toLowerCase().includes(qRaw) || op.id.toLowerCase() === qRaw)) score += 6;
      if (!q.length) score = 1;
      if (score > 0) scored.push({ op, score });
    }
    scored.sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length);
    return scored.slice(0, opts.limit ?? 15).map(({ op }) => ({
      operationId: op.id,
      method: op.method,
      path: op.path,
      summary: op.summary,
      tags: op.tags,
    }));
  }

  /** Resolve a schema to a compact, readable form with $refs inlined up to `depth` levels */
  simplify(schema: any, depth: number, seen: Set<string> = new Set()): any {
    if (!schema || typeof schema !== "object") return schema;
    if (schema.$ref) {
      const name = schema.$ref.split("/").pop();
      if (seen.has(schema.$ref) || depth <= 0) return `<${name}>`;
      const next = new Set(seen);
      next.add(schema.$ref);
      const resolved = this.simplify(this.ref(schema.$ref), depth - 1, next);
      return typeof resolved === "object" && !Array.isArray(resolved) ? { $schema: name, ...resolved } : resolved;
    }
    if (schema.oneOf || schema.anyOf) {
      const list = (schema.oneOf ?? schema.anyOf).map((s: any) => (s.$ref ? `<${s.$ref.split("/").pop()}>` : this.simplify(s, depth - 1, seen)));
      return { oneOf: list };
    }
    if (schema.allOf) {
      const merged: any = {};
      for (const part of schema.allOf) {
        const s = this.simplify(part, depth, seen);
        if (s && typeof s === "object" && s.properties) merged.properties = { ...(merged.properties ?? {}), ...s.properties };
      }
      return merged;
    }
    if (schema.type === "array") {
      return [this.simplify(schema.items ?? {}, depth, seen)];
    }
    if (schema.type === "object" || schema.properties) {
      const out: any = {};
      const req: string[] = schema.required ?? [];
      for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
        if (v?.readOnly) continue;
        out[k + (req.includes(k) ? " (required)" : "")] = this.simplify(v, depth, seen);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        out["<key>"] = this.simplify(schema.additionalProperties, depth, seen);
      }
      return Object.keys(out).length ? { properties: out } : "object";
    }
    let t = schema.type ?? "any";
    if (schema.format) t += `(${schema.format})`;
    if (schema.enum) t += ` enum: ${schema.enum.join("|")}`;
    if (schema.default !== undefined) t += ` default: ${JSON.stringify(schema.default)}`;
    return t;
  }

  private pickContent(content: any): { mediaType: string; schema: any } | undefined {
    if (!content) return undefined;
    const mt = content["application/json"] ? "application/json" : Object.keys(content)[0];
    return mt ? { mediaType: mt, schema: content[mt]?.schema } : undefined;
  }

  describe(id: string, depth = 3) {
    const op = this.byId.get(id);
    if (!op) return undefined;
    const rb = op.raw.requestBody;
    const rbC = this.pickContent(rb?.content);
    const responses: Record<string, unknown> = {};
    for (const [code, r] of Object.entries<any>(op.raw.responses ?? {})) {
      if (!/^2/.test(code)) continue;
      const c = this.pickContent(r.content);
      responses[code] = c?.schema ? this.simplify(c.schema, Math.min(depth, 2)) : stripHtml(r.description) || "no body";
    }
    return {
      operationId: op.id,
      method: op.method,
      path: op.path,
      summary: op.summary,
      description: op.description.slice(0, 1500) || undefined,
      tags: op.tags,
      parameters: op.params,
      requestBody: rb
        ? {
            required: !!rb.required,
            mediaTypes: Object.keys(rb.content ?? {}),
            schema: rbC?.schema ? this.simplify(rbC.schema, depth) : undefined,
          }
        : undefined,
      responses,
      errorCodes: Object.keys(op.raw.responses ?? {}).filter((c) => !/^2/.test(c)),
    };
  }

  /** Find the spec operation matching a concrete method + path, e.g. GET /workflows/abc */
  match(method: string, concretePath: string): Operation | undefined {
    const clean = concretePath.split("?")[0];
    return this.ops.find((o) => {
      if (o.method !== method.toUpperCase()) return false;
      const re = new RegExp("^" + o.path.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+").replace(/\*\*/g, ".*") + "/?$");
      return re.test(clean);
    });
  }
}
