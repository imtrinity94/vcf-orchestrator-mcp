/**
 * Conversion between plain JSON values and the Orchestrator REST "typed value" wire format, e.g.
 *   "hello"             <-> { "string": { "value": "hello" } }
 *   { a: 1 }  (Properties) <-> { "properties": { "property": [ { "key": "a", "value": { "number": { "value": 1 } } } ] } }
 *   "vm-42" (VC:VirtualMachine) -> { "sdk-object": { "type": "VC:VirtualMachine", "id": "vm-42" } }
 */

const WIRE_KEYS = [
  "string",
  "secure-string",
  "encrypted-string",
  "number",
  "boolean",
  "date",
  "array",
  "properties",
  "sdk-object",
  "composite",
  "mime-attachment",
  "regex",
];

export function isWireValue(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  return keys.length === 1 && WIRE_KEYS.includes(keys[0]);
}

function inferWire(v: unknown): any {
  if (isWireValue(v)) return v;
  if (v === null || v === undefined) return { string: { value: "" } };
  if (typeof v === "string") return { string: { value: v } };
  if (typeof v === "number") return { number: { value: v } };
  if (typeof v === "boolean") return { boolean: { value: v } };
  if (Array.isArray(v)) return { array: { elements: v.map(inferWire) } };
  if (typeof v === "object") {
    return {
      properties: {
        property: Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: inferWire(value) })),
      },
    };
  }
  return { string: { value: String(v) } };
}

export function toWire(type: string | undefined, v: unknown): any {
  if (isWireValue(v)) return v;
  const t = (type ?? "Any").trim();
  const lt = t.toLowerCase();
  if (lt.startsWith("array/")) {
    const inner = t.slice(6);
    const arr = Array.isArray(v) ? v : [v];
    return { array: { elements: arr.map((e) => toWire(inner, e)) } };
  }
  switch (lt) {
    case "string":
    case "text":
      return { string: { value: v == null ? "" : typeof v === "string" ? v : JSON.stringify(v) } };
    case "securestring":
      return { "secure-string": { value: String(v ?? "") } };
    case "encryptedstring":
      return { "encrypted-string": { value: String(v ?? "") } };
    case "number":
      return { number: { value: Number(v) } };
    case "boolean":
      return { boolean: { value: v === true || v === "true" || v === 1 } };
    case "date": {
      const d = v instanceof Date ? v : new Date(String(v));
      return { date: { value: isNaN(d.getTime()) ? String(v) : d.toISOString() } };
    }
    case "properties":
      if (v && typeof v === "object" && !Array.isArray(v)) return inferWire(v);
      return inferWire(typeof v === "string" ? JSON.parse(v) : {});
    case "any":
      return inferWire(v);
  }
  if (t.includes(":")) {
    // plug-in (SDK) object: accept "id", {id}, {id,type}
    const id = typeof v === "object" && v !== null ? (v as any).id : v;
    const sdkType = typeof v === "object" && v !== null && (v as any).type ? (v as any).type : t;
    return { "sdk-object": { type: sdkType, id: String(id) } };
  }
  // CompositeType(...) or anything else: best effort
  return inferWire(v);
}

/** Wire → plain JSON (tolerant of several shapes the API returns) */
export function fromWire(w: any): any {
  if (!w || typeof w !== "object") return w;
  if (Array.isArray(w)) return w.map(fromWire);
  const keys = Object.keys(w);
  if (keys.length !== 1 && !keys.includes("objectType")) {
    // already plain or a parameter wrapper
    return w;
  }
  const k = keys.find((x) => x !== "objectType") ?? keys[0];
  const inner = w[k];
  switch (k) {
    case "string":
    case "secure-string":
    case "encrypted-string":
    case "number":
    case "boolean":
    case "date":
    case "regex":
      return inner?.value;
    case "array": {
      const els = inner?.elements ?? inner?.element ?? [];
      return (Array.isArray(els) ? els : [els]).map(fromWire);
    }
    case "properties": {
      const list = inner?.property ?? inner?.properties ?? (Array.isArray(inner) ? inner : []);
      const out: Record<string, unknown> = {};
      for (const p of Array.isArray(list) ? list : [list]) if (p && p.key !== undefined) out[p.key] = fromWire(p.value);
      return out;
    }
    case "sdk-object":
      return { type: inner?.type, id: inner?.id, displayValue: inner?.displayValue ?? inner?.["display-value"] };
    case "composite": {
      const list = inner?.property ?? inner?.CompositeObjectValue ?? [];
      const out: Record<string, unknown> = {};
      for (const p of list) out[p.id ?? p.key] = fromWire(p.value);
      return out;
    }
    case "mime-attachment":
      return { name: inner?.name, mimeType: inner?.["mime-type"], size: inner?.content?.length };
    default:
      return w;
  }
}

/** [{name,type,value}] → { name: plainValue } */
export function paramsToObject(params: any[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params ?? []) {
    if (!p?.name) continue;
    out[p.name] = p.value === undefined ? null : fromWire(p.value);
  }
  return out;
}

export interface ParamDef {
  name: string;
  type: string;
  description?: string;
}

/** Build the REST "parameters" array from a plain {name: value} map using declared types */
export function buildParameters(defs: ParamDef[], inputs: Record<string, unknown>, strict = true): any[] {
  const out: any[] = [];
  const known = new Map(defs.map((d) => [d.name, d]));
  for (const [name, value] of Object.entries(inputs ?? {})) {
    const def = known.get(name);
    if (!def && strict) {
      throw new Error(
        `Unknown input "${name}". Declared inputs: ${defs.map((d) => `${d.name} (${d.type})`).join(", ") || "none"}`
      );
    }
    const type = def?.type ?? "Any";
    out.push({ name, type: type === "Any" && !def ? guessType(value) : type, scope: "local", value: toWire(type, value) });
  }
  return out;
}

function guessType(v: unknown): string {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "Array/Any";
  if (v && typeof v === "object") return isWireValue(v) ? "Any" : "Properties";
  return "string";
}
