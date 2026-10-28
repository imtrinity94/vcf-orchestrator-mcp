/**
 * Remembers every Orchestrator object saved through this MCP (per Orchestrator host), so
 * vro_build_package can put exactly "what was pushed" into a package. Kept in a small JSON
 * file so the list survives client restarts until a package is built or the list is cleared.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ChangeKind = "workflow" | "action" | "configuration" | "resource";

export interface TrackedChange {
  kind: ChangeKind;
  id: string;
  /** workflow name, action module/name, element name */
  name: string;
  /** workflow folder or element folder, when known */
  folder?: string;
  version?: string;
  savedAt: string;
}

type Store = Record<string, TrackedChange[]>;

export class ChangeTracker {
  constructor(private host: string, private file = path.join(homedir(), ".vcf-orchestrator-mcp", "changes.json")) {}

  private read(): Store {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Store;
    } catch {
      return {};
    }
  }

  private write(all: Store) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (e: any) {
      console.error(`[vcf-orchestrator-mcp] could not save tracked changes to ${this.file}: ${e.message}`);
    }
  }

  list(): TrackedChange[] {
    return this.read()[this.host] ?? [];
  }

  record(c: Omit<TrackedChange, "savedAt">) {
    const all = this.read();
    const list = (all[this.host] ?? []).filter((x) => !(x.kind === c.kind && x.id === c.id));
    list.push({ ...c, savedAt: new Date().toISOString() });
    all[this.host] = list;
    this.write(all);
  }

  forget(kind: ChangeKind, id: string) {
    const all = this.read();
    all[this.host] = (all[this.host] ?? []).filter((x) => !(x.kind === kind && x.id === id));
    this.write(all);
  }

  clear(ids?: string[]) {
    const all = this.read();
    all[this.host] = ids ? (all[this.host] ?? []).filter((x) => !ids.includes(x.id)) : [];
    this.write(all);
  }
}
