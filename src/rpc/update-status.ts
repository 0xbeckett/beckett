/**
 * Write the RPC status file so the daemon picks up the current activity.
 * Called by the shell whenever task state changes.
 *
 * Usage: bun src/rpc/update-status.ts "<details>" "<state>"
 */
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const BECKETT_DIR = process.env.BECKETT_DIR ?? join(process.env.HOME ?? "/home/beckett", ".beckett");
const STATUS_FILE = join(BECKETT_DIR, "rpc-status.json");

const details = process.argv[2] ?? "on standby";
const state = process.argv[3] ?? "loom-desk";

mkdirSync(BECKETT_DIR, { recursive: true });
writeFileSync(STATUS_FILE, JSON.stringify({ details, state, updatedAt: Date.now() }, null, 2));
console.log(`[rpc-status] updated: "${details}" / "${state}"`);
