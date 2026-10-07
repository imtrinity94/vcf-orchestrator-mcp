import { Agent, fetch, type Dispatcher } from "undici";
import type { AuthMode, Config } from "./config.js";

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
  body: unknown;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

type ResolvedMode = Exclude<AuthMode, "auto">;

export class OrchestratorClient {
  private dispatcher: Dispatcher;
  private authHeader?: string;
  private resolvedMode?: ResolvedMode;
  private loginInFlight?: Promise<void>;

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
    const text = await res.text();
    if (!text) return null;
    const ct = res.headers.get("content-type") ?? "";
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
    if (!res.ok) throw new ApiError(`VCFA login failed (${res.status})`, res.status, data);
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

  /** VCF Automation 9 org (cloudapi) session: user@org basic → x-vmware-vcloud-access-token */
  private async loginCloudApi(): Promise<string> {
    const { user, pass } = this.requireCreds("vcfa-cloudapi");
    const org = this.cfg.org ?? "System";
    const principal = user.includes("@") ? user : `${user}@${org}`;
    const isProvider = org.toLowerCase() === "system";
    const url = `${this.cfg.authUrl}/cloudapi/1.0.0/sessions${isProvider ? "/provider" : ""}`;
    const res = await this.rawFetch(url, {
      method: "POST",
      headers: {
        Authorization: this.basicHeader(principal, pass),
        Accept: `application/json;version=${this.cfg.cloudapiVersion}`,
      },
    });
    const data = await OrchestratorClient.readBody(res);
    const tok = res.headers.get("x-vmware-vcloud-access-token");
    if (!res.ok || !tok) throw new ApiError(`VCFA cloudapi session login failed (${res.status})`, res.status, data);
    return `Bearer ${tok}`;
  }

  private async headerFor(mode: ResolvedMode): Promise<string> {
    switch (mode) {
      case "token":
        if (!this.cfg.token) throw new Error('Auth mode "token" needs VRO_TOKEN');
        return this.cfg.token.startsWith("Bearer ") ? this.cfg.token : `Bearer ${this.cfg.token}`;
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
