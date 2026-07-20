/**
 * Beckett — Agent store (`src/agent/store.ts`)
 * =======================================================================================
 * Durable registry of agent definitions, persisted as one Zod-validated JSON file at
 * `<beckettDir>/agents.json`, with the same atomic tmp+rename + directory-lock discipline as the
 * routine registry ({@link ../routine/store.ts}) so the CLI and the daemon can both mutate it
 * safely (issue #66).
 *
 * The store is the single source of truth: the daemon re-reads it via the live loader
 * ({@link ./registry.ts}) whenever it enumerates agents, so a `beckett agent add/rm` from the
 * CLI is picked up without a restart — exactly like routines.
 *
 * The strict `read()` here (used by the CLI mutate path) is fail-loud on a corrupt file so a bad
 * write is never silently compounded. The daemon's enumeration path is DELIBERATELY separate and
 * defensive (per-entry log-and-skip) so a hand-corrupted file can never take the daemon down —
 * see {@link ./registry.ts}.
 *
 * Built-ins are seeded on load unless the user removed them (`removedBuiltins`).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { builtinAgentDefs } from "./builtins.ts";
import { AgentRegistrySchema, type AgentDefinition, type AgentRegistry } from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;

export interface AgentStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Seed the built-in agents on load (default true; tests disable for a clean slate). */
  seedBuiltins?: boolean;
}

const EMPTY: AgentRegistry = { version: 1, agents: [], removedBuiltins: [] };

export class AgentStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly seedBuiltins: boolean;

  constructor(path: string, opts: AgentStoreOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? (() => randomUUID().slice(0, 8));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.seedBuiltins = opts.seedBuiltins ?? true;
  }

  /** All agents (seeding built-ins if needed), sorted by id for stable output. */
  async list(): Promise<AgentDefinition[]> {
    return this.mutate((reg) => reg.agents.slice().sort((a, b) => a.id.localeCompare(b.id)));
  }

  /** One agent by id, or null. */
  async get(id: string): Promise<AgentDefinition | null> {
    return this.mutate((reg) => reg.agents.find((a) => a.id === id) ?? null);
  }

  /** Add a user agent. Throws on a duplicate id. */
  async add(def: Omit<AgentDefinition, "createdAt" | "updatedAt" | "builtin">): Promise<AgentDefinition> {
    return this.mutate((reg) => {
      if (reg.agents.some((a) => a.id === def.id)) throw new Error(`agent already exists: ${def.id}`);
      const now = this.now().toISOString();
      const agent: AgentDefinition = { ...def, builtin: false, createdAt: now, updatedAt: now };
      reg.agents.push(agent);
      return structuredClone(agent);
    });
  }

  /** Remove an agent by id. A built-in is remembered as removed so seeding won't restore it. */
  async remove(id: string): Promise<boolean> {
    return this.mutate((reg) => {
      const idx = reg.agents.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      const [removed] = reg.agents.splice(idx, 1);
      if (removed?.builtin && !reg.removedBuiltins.includes(id)) reg.removedBuiltins.push(id);
      return true;
    });
  }

  // --- persistence internals (mirrors RoutineStore) -----------------------------------------

  private read(): AgentRegistry {
    try {
      const raw = readFileSync(this.path, "utf8");
      return AgentRegistrySchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY);
      throw new Error(`agent registry ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  /** Seed any built-in not present and not in the removed list. Returns true if it changed. */
  private seed(reg: AgentRegistry): boolean {
    if (!this.seedBuiltins) return false;
    let changed = false;
    const now = this.now().toISOString();
    for (const def of builtinAgentDefs()) {
      if (reg.removedBuiltins.includes(def.id)) continue;
      if (reg.agents.some((a) => a.id === def.id)) continue;
      reg.agents.push({ ...def, createdAt: now, updatedAt: now });
      changed = true;
    }
    return changed;
  }

  private async mutate<T>(change: (reg: AgentRegistry) => T): Promise<T> {
    await this.acquireLock();
    try {
      const reg = this.read();
      const seeded = this.seed(reg);
      const before = JSON.stringify(reg);
      const result = change(reg);
      if (seeded || JSON.stringify(reg) !== before) this.write(reg);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private write(reg: AgentRegistry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.id()}.tmp`;
    writeFileSync(temp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }

  private async acquireLock(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        mkdirSync(this.lockPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await this.sleep(25);
      }
    }
    throw new Error(`agent registry lock is held: ${this.lockPath}`);
  }
}
