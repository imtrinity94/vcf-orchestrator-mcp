/**
 * One-time service account setup for VCF Automation 9 (tenant org), following the E2E token flow:
 *   1. session login (user@org)            POST /tm/cloudapi/1.0.0/sessions   (fallback /cloudapi/1.0.0/sessions)
 *   2. register service account            POST /oauth/tenant/{org}/register
 *   3. device authorization                POST /oauth/tenant/{org}/device_authorization
 *   4. grant the device (as the user)      POST /tm/cloudapi/1.0.0/deviceLookup/grant
 *   5. access + refresh token              POST /tm/oauth/tenant/{org}/token  (grant_type device_code)
 * The refresh token is stored in the token file; the MCP server renews access tokens from it and
 * saves every rotated refresh token, so no token ever has to be pasted again.
 */
import { Agent, request } from "undici";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { defaultTokenFile, saveToken, tokenKey } from "./tokenStore.js";

interface Args {
  url?: string;
  org?: string;
  user?: string;
  name?: string;
  role?: string;
  password?: string;
  clientId?: string;
  insecure?: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--url") { a.url = v; i++; }
    else if (k === "--org") { a.org = v; i++; }
    else if (k === "--user") { a.user = v; i++; }
    else if (k === "--name") { a.name = v; i++; }
    else if (k === "--role") { a.role = v; i++; }
    else if (k === "--password") { a.password = v; i++; }
    else if (k === "--client-id") { a.clientId = v; i++; }
    else if (k === "--insecure") a.insecure = true;
    else if (k === "--help" || k === "-h") {
      console.log(
        "Usage: vcf-orchestrator-mcp setup --url https://auto.example.lab --org <org> --user <user> --name <service account name> [--role \"Organization Administrator\"] [--password <pw>] [--insecure]\n" +
          "   or: vcf-orchestrator-mcp setup --url https://auto.example.lab --org <org> --client-id <service account client ID> [--insecure]\n" +
          "       (service account created in the VCF Automation UI; you approve the access request in the UI, no password needed)\n" +
          "Without --password (or VRO_PASSWORD) the password is asked for with a masked prompt. It is never stored."
      );
      process.exit(0);
    }
  }
  return a;
}

function ask(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

/** Masked password prompt (shows * per character). Works in Windows PowerShell/cmd and Unix terminals. */
function askPassword(q: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    if (!stdin.isTTY) {
      // piped input, e.g. echo pw | vcf-orchestrator-mcp setup ...
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => { buf += d; });
      stdin.once("end", () => { process.stdout.write("\n"); resolve(buf.split(/\r?\n/)[0]); });
      stdin.resume();
      return;
    }
    let pw = "";
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") { finish(); resolve(pw); return; }
        if (ch === "\u0003") { finish(); reject(new Error("Cancelled")); return; }
        if (ch === "\u0008" || ch === "\u007f") {
          if (pw.length) { pw = pw.slice(0, -1); process.stdout.write("\b \b"); }
          continue;
        }
        if (ch < " ") continue;
        pw += ch;
        process.stdout.write("*");
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function short(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return (s ?? "").replace(/\s+/g, " ").slice(0, 300);
}

export async function runSetup(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const url = (a.url || process.env.VRO_URL || (await ask("VCF Automation URL (e.g. https://auto.vmw.lab): "))).replace(/\/+$/, "");
  const org = a.org || process.env.VRO_ORG || (await ask("Organization name: "));
  const uiMode = !!a.clientId;
  const user = uiMode ? "" : a.user || process.env.VRO_USERNAME || (await ask(`Username (without @${org}): `));
  const name = uiMode ? "" : a.name || (await ask("Service account name (shown in VCF Automation): "));
  const role = a.role || "Organization Administrator";
  const insecure = a.insecure ?? /^(1|true|yes)$/i.test(process.env.VRO_INSECURE ?? "");
  if (!url || !org) throw new Error("url and org are required");
  if (!uiMode && (!user || !name)) throw new Error("user and service account name are required (or use --client-id)");
  const password = uiMode ? "" : a.password || process.env.VRO_PASSWORD || (await askPassword(`Password for ${user}@${org}: `));
  if (!uiMode && !password) throw new Error("No password entered");

  const dispatcher = new Agent({ connect: { rejectUnauthorized: !insecure } });
  // Plain HTTP request (like curl): undici fetch() adds browser headers (sec-fetch-mode etc.)
  // that VCF Automation's session login rejects with 401.
  const req = async (method: string, path: string, headers: Record<string, string>, body?: string) => {
    const r = await request(`${url}${path}`, {
      method: method as any,
      headers: { "user-agent": "vcf-orchestrator-mcp", ...headers },
      body,
      dispatcher,
    }).catch((e: any) => {
      const cause = e?.cause?.code || e?.code || e?.message;
      throw new Error(`Cannot reach ${url}${path}: ${cause}${/CERT|SELF_SIGNED/i.test(String(cause)) ? " (use --insecure for self-signed lab certificates)" : ""}`);
    });
    const text = await r.body.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    const h = r.headers;
    const one = (k: string) => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; };
    const res = {
      status: r.statusCode,
      ok: r.statusCode >= 200 && r.statusCode < 300,
      headers: {
        get: one,
        getSetCookie: () => { const v = h["set-cookie"]; return Array.isArray(v) ? v : v ? [v] : []; },
      },
    };
    return { res, json };
  };
  const cookieOf = (res: any, name: string): string | undefined => {
    const all: string[] = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
    for (const c of all) {
      const m = String(c).match(new RegExp(`(?:^|[;,\\s])${name}=([^;]+)`));
      if (m) return m[1];
    }
    return undefined;
  };

  let session: string | undefined;
  let jwtCookie: string | undefined;
  let clientId: string | undefined = a.clientId;
  if (!uiMode) {
  // 1. Session login
  const basic = "Basic " + Buffer.from(`${user}@${org}:${password}`).toString("base64");
  const tried: string[] = [];
  outer: for (const p of ["/tm/cloudapi/1.0.0/sessions", "/cloudapi/1.0.0/sessions"]) {
    for (const v of ["40.0", "9.1.0", "9.0.0"]) {
      const { res, json } = await req("POST", p, { Authorization: basic, Accept: `application/json;version=${v}` });
      const tok = res.headers.get("x-vmware-vcloud-access-token");
      if (res.ok && tok) { session = tok; jwtCookie = cookieOf(res, "vcloud_jwt"); console.log(`1/5 Logged in as ${user}@${org} (${p})`); break outer; }
      tried.push(`${p} v${v}: HTTP ${res.status} ${short(json)}`);
      if (res.status === 401 || res.status === 403 || res.status === 404) break;
    }
  }
  if (!session) {
    throw new Error(
      "Login failed:\n  " + tried.join("\n  ") +
        `\n  401 means VCF Automation rejected ${user}@${org}: check the password, and that '${user}' is a local user inside org '${org}'.` +
        `\n  Users who sign in through SSO / an identity provider cannot log in with a password here. In that case create the service account` +
        `\n  in the VCF Automation UI and run: vcf-orchestrator-mcp setup --url ${url} --org ${org} --client-id <its client ID>${insecure ? " --insecure" : ""}`
    );
  }

  // 2. Register service account
  const reg = await req(
    "POST",
    `/oauth/tenant/${encodeURIComponent(org)}/register`,
    { Accept: "application/json;version=40.0", "Content-Type": "application/json", Authorization: `Bearer ${session}`, ...(jwtCookie ? { Cookie: `vcloud_jwt=${jwtCookie}` } : {}) },
    JSON.stringify({ client_name: name, software_id: randomUUID(), software_version: "1.0", client_uri: "vmware.com", scope: `urn:vcloud:role:${encodeURIComponent(role)}` })
  );
  clientId = reg.json?.client_id;
  if (!reg.res.ok || !clientId) throw new Error(`Registering service account failed: HTTP ${reg.res.status} ${short(reg.json)}`);
  jwtCookie = cookieOf(reg.res, "vcloud_jwt") ?? jwtCookie;
  console.log(`2/5 Service account '${name}' registered (client_id ${clientId}, role ${role})`);
  }
  if (!clientId) throw new Error("No client ID");

  // 3. Device authorization
  const dev = await req(
    "POST",
    `/oauth/tenant/${encodeURIComponent(org)}/device_authorization`,
    { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ client_id: clientId }).toString()
  );
  const expiresIn = Number(dev.json?.expires_in) || 600;
  const interval = Math.max(2, Number(dev.json?.interval) || 5);
  const deviceCode: string | undefined = dev.json?.device_code;
  const userCode: string | undefined = dev.json?.user_code;
  if (!dev.res.ok || !deviceCode || !userCode) throw new Error(`Device authorization failed: HTTP ${dev.res.status} ${short(dev.json)}`);
  console.log(`3/5 Device authorization requested (user code ${userCode})`);

  // 4. Grant: as the logged-in user, or by you in the UI
  let grantBearer: string | undefined = jwtCookie ?? session;
  let granted = false;
  if (grantBearer) {
    const grant = await req(
      "POST",
      "/tm/cloudapi/1.0.0/deviceLookup/grant",
      { accept: "*/*;version=40.0", Authorization: `Bearer ${grantBearer}`, "Content-Type": "application/json", Cookie: `vcloud_jwt=${grantBearer}` },
      JSON.stringify({ userCode })
    );
    granted = grant.res.ok;
    if (granted) console.log("4/5 Service account granted");
    else console.log(`4/5 Automatic grant failed (HTTP ${grant.res.status} ${short(grant.json)})`);
  }
  if (!granted) {
    console.log(
      `\n    Approve it in the VCF Automation UI now: sign in to org ${org}, open the service account's access requests` +
        `\n    (Administration > Service Accounts${dev.json?.verification_uri ? `, or ${dev.json.verification_uri}` : ""}) and grant code:  ${userCode}` +
        `\n    Waiting up to ${Math.round(expiresIn / 60)} minutes...`
    );
  }

  // 5. Token (device_code grant); retry while pending
  let tokens: any;
  let tokenEndpoint = "";
  const tokenPaths = [`/tm/oauth/tenant/${encodeURIComponent(org)}/token`, `/oauth/tenant/${encodeURIComponent(org)}/token`];
  const deadline = Date.now() + (granted ? 30 : expiresIn) * 1000;
  let last = "";
  while (!tokens && Date.now() < deadline) {
    for (const p of tokenPaths) {
      const t = await req(
        "POST",
        p,
        { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...(grantBearer ? { Cookie: `vcloud_jwt=${grantBearer}` } : {}) },
        new URLSearchParams({ client_id: clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }).toString()
      );
      if (t.res.ok && t.json?.access_token) { tokens = t.json; tokenEndpoint = p; break; }
      if (t.res.status === 404) continue;
      last = `HTTP ${t.res.status} ${short(t.json)}`;
      if (/authorization_pending|slow_down/i.test(last)) break;
      if (/access_denied|expired_token|invalid_client/i.test(last)) throw new Error(`Token request failed: ${last}`);
    }
    if (!tokens) await new Promise((r) => setTimeout(r, interval * 1000));
  }
  if (!tokens) throw new Error(`No token before the request expired${last ? ` (last answer: ${last})` : ""}. Run setup again and approve the code in time.`);
  if (!tokens?.refresh_token) throw new Error("No refresh token returned by the token endpoint");
  console.log(`5/5 Tokens issued (access token valid ${tokens.expires_in ?? "?"}s, refresh token stored)`);

  // Verify against VCF Automation and the embedded Orchestrator
  const auth = { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" };
  const iaas = await req("GET", "/iaas/api/projects?$top=1", auth);
  const vro = await req("GET", "/vco/api/workflows?maxResult=1", auth);
  console.log(`Check: VCF Automation IaaS API -> HTTP ${iaas.res.status}; Orchestrator /vco/api -> HTTP ${vro.res.status}`);

  const file = defaultTokenFile();
  saveToken(file, tokenKey(url, org), { seed: "setup", refreshToken: tokens.refresh_token, clientId: clientId!, tokenEndpoint });
  console.log(`\nSaved to ${file}\n`);
  console.log("Claude Desktop config (env block) - no token or password needed:");
  console.log(
    JSON.stringify({ VRO_URL: url, VRO_AUTH_MODE: "api-token", VRO_ORG: org, ...(insecure ? { VRO_INSECURE: "true" } : {}) }, null, 2)
  );
  if (vro.res.status >= 400) {
    console.log("\nNote: Orchestrator rejected the service account token. Check the service account role, or use VRO_AUTH_MODE=vcfa-cloudapi.");
  }
}
