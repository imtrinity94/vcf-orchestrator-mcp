import { fileURLToPath } from "node:url";
import path from "node:path";

export type AuthMode = "auto" | "basic" | "vcfa" | "vcfa-cloudapi" | "token";

export interface Config {
  /** Host where Orchestrator answers, e.g. https://vro.vmw.lab (external) or https://auto.vmw.lab (embedded in VCF Automation) */
  url: string;
  /** API base path appended to url */
  apiBase: string;
  authMode: AuthMode;
  /** Host used for token login (VCF Automation / Aria Automation). Defaults to url. */
  authUrl: string;
  username?: string;
  password?: string;
  /** Identity domain for VCFA "All Apps" / legacy CSP login (e.g. System Domain, vsphere.local, your AD domain) */
  domain?: string;
  /** VCFA tenant org name for the cloudapi session login (use "System" for provider) */
  org?: string;
  cloudapiVersion: string;
  token?: string;
  insecure: boolean;
  specPath: string;
  maxChars: number;
  timeoutMs: number;
  scratchModule: string;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const defaultSpec = path.resolve(here, "..", "spec", "vcfoo-9.0.0.json");

  const rawUrl = env.VRO_URL ?? env.VCFOO_URL ?? "";
  if (!rawUrl) {
    throw new Error(
      "VRO_URL is not set. Set it to the Orchestrator host, e.g. https://vro.vmw.lab (external) or https://auto.vmw.lab (embedded in VCF Automation)."
    );
  }
  let url = trimSlash(rawUrl);
  let apiBase = env.VRO_API_BASE ?? "/vco/api";
  // Accept VRO_URL given with the api path already on it
  const m = url.match(/^(https?:\/\/[^/]+)(\/.*)$/i);
  if (m && !env.VRO_API_BASE) {
    url = m[1];
    apiBase = m[2];
  }
  apiBase = "/" + apiBase.replace(/^\/+|\/+$/g, "");

  const mode = (env.VRO_AUTH_MODE ?? "auto").toLowerCase() as AuthMode;
  if (!["auto", "basic", "vcfa", "vcfa-cloudapi", "token"].includes(mode)) {
    throw new Error(`VRO_AUTH_MODE must be one of auto|basic|vcfa|vcfa-cloudapi|token (got "${mode}")`);
  }

  return {
    url,
    apiBase,
    authMode: mode,
    authUrl: trimSlash(env.VRO_AUTH_URL ?? url),
    username: env.VRO_USERNAME,
    password: env.VRO_PASSWORD,
    domain: env.VRO_DOMAIN,
    org: env.VRO_ORG,
    cloudapiVersion: env.VRO_CLOUDAPI_VERSION ?? "40.0",
    token: env.VRO_TOKEN,
    insecure: bool(env.VRO_INSECURE, false),
    specPath: env.VRO_SPEC_PATH ? path.resolve(env.VRO_SPEC_PATH) : defaultSpec,
    maxChars: Number(env.VRO_MAX_CHARS ?? 25000),
    timeoutMs: Number(env.VRO_TIMEOUT_MS ?? 60000),
    scratchModule: env.VRO_SCRATCH_MODULE ?? "com.mcp.scratch",
  };
}
