import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Persists service-account refresh tokens per VCF Automation host + org.
 * VCF Automation rotates the refresh token on every use (unless "Require rotation" is off),
 * so the newest one must survive restarts - otherwise the next start fails with invalid_grant.
 */
export interface StoredToken {
  /** The token the chain started from (VRO_API_TOKEN value, or "setup") - a new seed resets the chain */
  seed: string;
  refreshToken: string;
  clientId?: string;
  tokenEndpoint?: string;
  updatedAt: string;
}

type StoreFile = Record<string, StoredToken>;

export function defaultTokenFile(): string {
  return process.env.VRO_TOKEN_FILE || path.join(homedir(), ".vcf-orchestrator-mcp", "tokens.json");
}

export function tokenKey(authUrl: string, org: string): string {
  return `${authUrl.replace(/\/+$/, "").toLowerCase()}|${org.toLowerCase()}`;
}

function readAll(file: string): StoreFile {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoreFile;
  } catch {
    return {};
  }
}

export function loadToken(file: string, key: string): StoredToken | undefined {
  return readAll(file)[key];
}

export function saveToken(file: string, key: string, entry: Omit<StoredToken, "updatedAt">): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const all = readAll(file);
  all[key] = { ...entry, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file); // atomic replace so a crash never leaves a half-written token
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows */
  }
}
