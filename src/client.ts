import { Agent, fetch, type Dispatcher } from "undici";
import type { AuthMode, Config } from "./config.js";
import { defaultTokenFile, loadToken, saveToken, tokenKey } from "./tokenStore.js";

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  /** "json" (default) | "xml" | "text" | explicit media type */
  accept?: string;
  contentType?: string;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON, a string, or a Buffer for binary responses (zip, octet-stream, images, ...) */
  body: unknown;
}

const TEXTUAL = /json|xml|text\/|javascript|x-www-form-urlencoded|yaml|csv|html/i;
const BINARY = /zip|octet-stream|application\/x-|pdf|image\/|audio\/|video\/|font\//i;

/** True when a response is binary and must not be decoded as text. */
export function looksBinary(contentType: string, bytes: Uint8Array): boolean {
  if (TEXTUAL.test(contentType)) return false;
  if (BINARY.test(contentType)) return true;
  // No (or an unknown) content type: sniff. Zip magic, or NUL bytes near the start.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return true;
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

type ResolvedMode = Exclude<AuthMode, "auto">;

function snippet(body: unknown, n = 300): string {
  if (body === null || body === undefined || body === "") return "";
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.replace(/\s+/g, " ").slice(0, n);
}

/** exp (seconds since epoch) of a JWT, if it is one */
export function jwtExpiry(token: string): number | undefined {
  try {
    const part = token.replace(/^Bearer\s+/i, "").split(".")[1];
    if (!part) return undefined;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : undefined;
  } catch {
    return undefined;
  }
}

export class OrchestratorClient {
  private dispatcher: Dispatcher;
  private authHeader?: string;
  private resolvedMode?: ResolvedMode;
  private loginInFlight?: Promise<void>;
  /** epoch ms when the current bearer expires (if known) */
  private expiresAt?: number;
  private lastTokenEndpoint?: string;

  constructor(public cfg: Config) {
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: !cfg.insecure },
      headersTimeout: cfg.timeoutMs,
      bodyTimeout: cfg.timeoutMs,
    });
  }

  get authMode(): string {
    return this.resolvedMode ?? `${this.cfg.authMode} (not logged in yet)`;
  }

  get tokenExpiresAt(): string | undefined {
    return this.expiresAt ? new Date(this.expiresAt).toISOString() : undefined;
  }

  // ---------- low level ----------

  private async rawFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    try {
      return await fetch(url, { ...init, dispatcher: this.dispatcher });
    } catch (e: any) {
      const cause = e?.cause?.code || e?.cause?.message || e?.message;
      const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(cause))
        ? " (certificate not trusted — set VRO_INSECURE=true for self-signed lab certs)"
        : "";
      throw new Error(`Cannot reach ${url}: ${cause}${hint}`);
    }
  }

  private static async readBody(res: Awaited<ReturnType<typeof fetch>>): Promise<unknown> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (looksBinary(ct, bytes)) return Buffer.from(bytes);
    const text = Buffer.from(bytes).toString("utf8");
    if (ct.includes("json") || /^[\s]*[{[]/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        /* fall through */
      }
    }
    return text;
  }

  // ---------- auth ----------

  private basicHeader(user: string, pass: string) {
    return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  private requireCreds(mode: string) {
    if (!this.cfg.username || !this.cfg.password) {
      throw new Error(`Auth mode "${mode}" needs VRO_USERNAME and VRO_PASSWORD`);
    }
    return { user: this.cfg.username, pass: this.cfg.password };
  }

  /** VCF Automation "All Apps" / Aria Automation 8 style: CSP login → (optional) IaaS login → bearer */
  private async loginVcfa(): Promise<string> {
    const { user, pass } = this.requireCreds("vcfa");
    const body: Record<string, string> = { username: user, password: pass };
    if (this.cfg.domain) body.domain = this.cfg.domain;
    const res = await this.rawFetch(`${this.cfg.authUrl}/csp/gateway/am/api/login?access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data: any = await OrchestratorClient.readBody(res);
    if (!res.ok) {
      const hint =
        res.status === 404
          ? " — this host has no /csp login endpoint (VCF Automation 9 tenant orgs use the cloudapi login: set VRO_AUTH_MODE=vcfa-cloudapi and VRO_ORG=<your org>)"
          : "";
      throw new ApiError(`VCFA (CSP) login failed: HTTP ${res.status} ${snippet(data)}${hint}`, res.status, data);
    }
    if (data?.access_token) return `Bearer ${data.access_token}`;
    const refresh = data?.refresh_token;
    if (!refresh) throw new ApiError("VCFA login returned no token", res.status, data);
    const res2 = await this.rawFetch(`${this.cfg.authUrl}/iaas/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    const d2: any = await OrchestratorClient.readBody(res2);
    if (!res2.ok || !d2?.token) throw new ApiError(`IaaS login failed (${res2.status})`, res2.status, d2);
    return `Bearer ${d2.token}`;
  }

  /** VCF Automation 9 session login: Basic user@org -> x-vmware-vcloud-access-token (tenant: /cloudapi, /tm/cloudapi; provider: /sessions/provider) */
  private async loginCloudApi(): Promise<string> {
    const { user, pass } = this.requireCreds("vcfa-cloudapi");
    const org = this.cfg.org ?? "System";
    // Principal is user@org. AD/UPN users (mayank@vmw.lab) become mayank@vmw.lab@Org.
    const principal = user.toLowerCase().endsWith(`@${org.toLowerCase()}`) ? user : `${user}@${org}`;
    const isProvider = org.toLowerCase() === "system";
    const urls = isProvider
      ? [`${this.cfg.authUrl}/cloudapi/1.0.0/sessions/provider`, `${this.cfg.authUrl}/tm/cloudapi/1.0.0/sessions/provider`]
      : [`${this.cfg.authUrl}/cloudapi/1.0.0/sessions`, `${this.cfg.authUrl}/tm/cloudapi/1.0.0/sessions`];
    const versions = [...new Set([this.cfg.cloudapiVersion, "9.1.0", "9.0.0", "40.0"])];
    const tried: string[] = [];
    for (const url of urls) {
      for (const v of versions) {
        const res = await this.rawFetch(url, {
          method: "POST",
          headers: { Authorization: this.basicHeader(principal, pass), Accept: `application/json;version=${v}` },
        });
        const data = await OrchestratorClient.readBody(res);
        const tok = res.headers.get("x-vmware-vcloud-access-token");
        if (res.ok && tok) {
          const exp = jwtExpiry(tok);
          this.expiresAt = exp ? exp * 1000 : Date.now() + 25 * 60 * 1000;
          return `Bearer ${tok}`;
        }
        tried.push(`${url.replace(this.cfg.authUrl, "")} v${v} -> HTTP ${res.status} ${snippet(data, 160)}`);
        if (res.status === 401 || res.status === 403) break; // bad credentials: no point trying other versions here
        if (res.status === 404) break; // endpoint not on this host: next url
      }
    }
    throw new ApiError(`Session login failed for ${principal}:\n  ${tried.join("\n  ")}`, 0, undefined);
  }

  /** Service-account / API refresh token -> access token. Persists rotated refresh tokens so restarts keep working. */
  private async loginApiToken(): Promise<string> {
    const org = this.cfg.org ?? "System";
    const file = defaultTokenFile();
    const key = tokenKey(this.cfg.authUrl, org);
    const seed = (this.cfg.apiToken ?? "").trim();
    const stored = loadToken(file, key);

    // Use the newest rotated token unless the config now holds a different (new) seed
    let rt = seed;
    let clientId = this.cfg.clientId;
    if (stored && (!seed || stored.seed === seed)) {
      rt = stored.refreshToken;
      clientId = clientId ?? stored.clientId;
    }
    if (!rt) {
      throw new Error(
        `No refresh token for ${org}. Run once:  vcf-orchestrator-mcp setup  (creates a service account and stores its token in ${file}), or set VRO_API_TOKEN.`
      );
    }

    const provider = org.toLowerCase() === "system";
    const paths = provider
      ? ["/oauth/provider/token", "/tm/oauth/provider/token"]
      : [`/oauth/tenant/${encodeURIComponent(org)}/token`, `/tm/oauth/tenant/${encodeURIComponent(org)}/token`];
    const preferred = this.lastTokenEndpoint ?? stored?.tokenEndpoint;
    if (preferred) paths.unshift(preferred);
    const tried: string[] = [];
    for (const p of [...new Set(paths)]) {
      const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: rt };
      if (clientId) form.client_id = clientId;
      const res = await this.rawFetch(`${this.cfg.authUrl}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
      const data: any = await OrchestratorClient.readBody(res);
      if (res.ok && data?.access_token) {
        this.lastTokenEndpoint = p;
        const ttl = Number(data.expires_in) || 0;
        this.expiresAt = ttl ? Date.now() + ttl * 1000 : (jwtExpiry(data.access_token) ?? 0) * 1000 || undefined;
        const next = data.refresh_token && data.refresh_token !== rt ? data.refresh_token : rt;
        try {
          saveToken(file, key, { seed: seed || stored?.seed || "setup", refreshToken: next, clientId, tokenEndpoint: p });
        } catch (e: any) {
          console.error(`[vcf-orchestrator-mcp] could not save rotated refresh token to ${file}: ${e.message}`);
        }
        return `Bearer ${data.access_token}`;
      }
      tried.push(`${p} -> HTTP ${res.status} ${snippet(data, 200)}`);
      if (res.status !== 404 && res.status !== 405) break;
    }
    const hint = tried.some((t) => /invalid_grant/i.test(t))
      ? `\n  The refresh token was already used or revoked. Run  vcf-orchestrator-mcp setup  again to issue a new one.`
      : "";
    throw new ApiError(`Token refresh failed (org ${org}):\n  ${tried.join("\n  ")}${hint}`, 0, undefined);
  }

  private async headerFor(mode: ResolvedMode): Promise<string> {
    switch (mode) {
      case "api-token":
        return this.loginApiToken();
      case "token": {
        if (!this.cfg.token) throw new Error('Auth mode "token" needs VRO_TOKEN');
        const raw = this.cfg.token.trim();
        const exp = jwtExpiry(raw);
        if (exp) {
          this.expiresAt = exp * 1000;
          if (exp * 1000 < Date.now()) {
            throw new Error(
              `VRO_TOKEN expired at ${new Date(exp * 1000).toISOString()} - paste a fresh token, or switch to VRO_AUTH_MODE=api-token with a long-lived VCF Automation API token`
            );
          }
        }
        return raw.startsWith("Bearer ") ? raw : `Bearer ${raw}`;
      }
      case "basic": {
        const { user, pass } = this.requireCreds("basic");
        return this.basicHeader(user, pass);
      }
      case "vcfa":
        return this.loginVcfa();
      case "vcfa-cloudapi":
        return this.loginCloudApi();
    }
  }

  /** Probe a cheap protected endpoint to check a header actually works against Orchestrator */
  private async probe(header: string): Promise<number> {
    const res = await this.rawFetch(this.apiUrl("/workflows", { maxResult: 1 }), {
      method: "GET",
      headers: { Authorization: header, Accept: "application/json" },
    });
    await res.text();
    return res.status;
  }

  private autoOrder(): ResolvedMode[] {
    if (this.cfg.apiToken || loadToken(defaultTokenFile(), tokenKey(this.cfg.authUrl, this.cfg.org ?? "System"))) return ["api-token"];
    if (this.cfg.token) return ["token"];
    const order: ResolvedMode[] = [];
    if (this.cfg.org) order.push("vcfa-cloudapi");
    order.push("vcfa", "basic");
    if (!this.cfg.org) order.push("vcfa-cloudapi");
    return order;
  }

  async login(force = false): Promise<void> {
    if (this.authHeader && !force) return;
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      try {
        if (this.cfg.authMode !== "auto" || (this.resolvedMode && force)) {
          const mode = (this.cfg.authMode !== "auto" ? this.cfg.authMode : this.resolvedMode) as ResolvedMode;
          this.authHeader = await this.headerFor(mode);
          this.resolvedMode = mode;
          return;
        }
        const errors: string[] = [];
        for (const mode of this.autoOrder()) {
          try {
            const h = await this.headerFor(mode);
            const status = await this.probe(h);
            if (status < 400) {
              this.authHeader = h;
              this.resolvedMode = mode;
              return;
            }
            errors.push(`${mode}: Orchestrator answered ${status}`);
          } catch (e: any) {
            errors.push(`${mode}: ${e.message}`);
          }
        }
        throw new Error("Could not authenticate to Orchestrator with any mode:\n  " + errors.join("\n  "));
      } finally {
        this.loginInFlight = undefined;
      }
    })();
    return this.loginInFlight;
  }

  /** Unauthenticated probes that show which login flavours this host offers */
  async diagnose(): Promise<Record<string, string>> {
    const probes: [string, string, string][] = [
      ["csp login (vcfa mode)", "GET", `${this.cfg.authUrl}/csp/gateway/am/api/login`],
      ["cloudapi sessions (vcfa-cloudapi mode)", "GET", `${this.cfg.authUrl}/cloudapi/1.0.0/sessions`],
      ["api versions", "GET", `${this.cfg.authUrl}/api/versions`],
      ["orchestrator about", "GET", `${this.cfg.url}${this.cfg.apiBase}/about`],
      ["orchestrator health", "GET", `${this.cfg.url}${this.cfg.apiBase}/healthstatus`],
    ];
    const out: Record<string, string> = {};
    await Promise.all(
      probes.map(async ([name, method, url]) => {
        try {
          const res = await this.rawFetch(url, { method, headers: { Accept: "application/json, */*" } });
          const body = await OrchestratorClient.readBody(res);
          let extra = "";
          if (name === "api versions" && typeof body === "string") {
            const vs = [...body.matchAll(/<Version>([^<]+)<\/Version>/g)].map((m) => m[1]);
            extra = vs.length ? ` versions: ${vs.slice(-6).join(", ")}` : "";
          } else if (res.ok) extra = " " + snippet(body, 150);
          out[name] = `HTTP ${res.status}${extra}  (${url})`;
        } catch (e: any) {
          out[name] = `unreachable: ${e.message}`;
        }
      })
    );
    return out;
  }

  // ---------- requests ----------

  apiUrl(p: string, query?: Record<string, unknown>): string {
    const pathPart = p.startsWith("http") ? p : `${this.cfg.url}${this.cfg.apiBase}${p.startsWith("/") ? "" : "/"}${p}`;
    const u = new URL(pathPart);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return u.toString();
  }

  private acceptHeader(a?: string): string {
    if (!a || a === "json") return "application/json";
    if (a === "xml") return "application/xml";
    if (a === "text") return "text/plain, */*";
    return a;
  }

  async request(method: string, p: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    // Refresh a minute before expiry when we can (api-token / password modes)
    const renewable = this.resolvedMode && this.resolvedMode !== "token" && this.resolvedMode !== "basic";
    if (renewable && this.expiresAt && this.expiresAt - Date.now() < 60_000) await this.login(true);
    await this.login();
    const doIt = async () => {
      const headers: Record<string, string> = {
        Accept: this.acceptHeader(opts.accept),
        Authorization: this.authHeader!,
        ...(opts.headers ?? {}),
      };
      let body: string | undefined;
      if (opts.body !== undefined && opts.body !== null && method !== "GET") {
        if (typeof opts.body === "string") {
          body = opts.body;
          headers["Content-Type"] = opts.contentType ?? (/^\s*</.test(body) ? "application/xml" : "application/json");
        } else {
          body = JSON.stringify(opts.body);
          headers["Content-Type"] = opts.contentType ?? "application/json";
        }
      }
      return this.rawFetch(this.apiUrl(p, opts.query), { method: method.toUpperCase(), headers, body });
    };
    let res = await doIt();
    if (res.status === 401 && this.resolvedMode === "token") {
      const exp = this.expiresAt;
      await res.text();
      throw new ApiError(
        exp && exp < Date.now()
          ? `HTTP 401 - VRO_TOKEN expired at ${new Date(exp).toISOString()}. Paste a fresh one, or use VRO_AUTH_MODE=api-token so tokens renew automatically.`
          : "HTTP 401 - Orchestrator rejected VRO_TOKEN (wrong org/scope, revoked, or incomplete copy).",
        401,
        null
      );
    }
    if (res.status === 401 && this.resolvedMode !== "basic") {
      await res.text();
      await this.login(true);
      res = await doIt();
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const body = await OrchestratorClient.readBody(res);
    return { status: res.status, ok: res.ok, headers, body };
  }

  /** Like request() but throws on non-2xx */
  async call(method: string, p: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    const r = await this.request(method, p, opts);
    if (!r.ok) {
      const detail = typeof r.body === "string" ? r.body.slice(0, 1500) : JSON.stringify(r.body)?.slice(0, 1500);
      throw new ApiError(`${method.toUpperCase()} ${p} → HTTP ${r.status}: ${detail}`, r.status, r.body);
    }
    return r;
  }
}
