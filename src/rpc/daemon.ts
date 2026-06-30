#!/usr/bin/env bun
/**
 * Beckett — Discord RPC daemon (`src/rpc/daemon.ts`)
 * ============================================================================
 * Connects to the Discord desktop app via its local IPC socket and maintains
 * a "Playing Beckett" rich presence. Updates the activity detail line with
 * live status pulled from the Beckett control socket (if available).
 *
 * Discord IPC protocol:
 *   - Unix socket at /tmp/discord-ipc-{0..9}
 *   - Packets: [opcode:uint32LE][length:uint32LE][json:utf8]
 *   - Opcodes: 0=HANDSHAKE, 1=FRAME, 2=CLOSE, 3=PING, 4=PONG
 *
 * Required env vars:
 *   DISCORD_RPC_CLIENT_ID  — your Discord application client ID
 *
 * Optional:
 *   DISCORD_RPC_LARGE_IMAGE  — asset key or mp:external/... URL (default: "beckett")
 *   DISCORD_RPC_DETAILS      — static detail line override
 *   BECKETT_DIR              — beckett runtime dir (for status polling)
 */

import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── opcodes ─────────────────────────────────────────────────────────────────
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_PING = 3;
const OP_PONG = 4;

// ── config ───────────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.DISCORD_RPC_CLIENT_ID ?? "";
const LARGE_IMAGE = process.env.DISCORD_RPC_LARGE_IMAGE ?? "beckett";
const STATIC_DETAILS = process.env.DISCORD_RPC_DETAILS ?? "";
const BECKETT_DIR = process.env.BECKETT_DIR ?? join(process.env.HOME ?? "/home/beckett", ".beckett");
const STATUS_FILE = join(BECKETT_DIR, "rpc-status.json");

if (!CLIENT_ID) {
  console.error("[rpc] DISCORD_RPC_CLIENT_ID is not set — exiting");
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function encode(op: number, payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json, "utf8");
  const buf = Buffer.alloc(8 + data.length);
  buf.writeUInt32LE(op, 0);
  buf.writeUInt32LE(data.length, 4);
  data.copy(buf, 8);
  return buf;
}

function findIpcPath(): string | null {
  for (let i = 0; i <= 9; i++) {
    const candidates = [
      `/tmp/discord-ipc-${i}`,
      `/run/user/${process.getuid?.() ?? 1000}/discord-ipc-${i}`,
      `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/discord-ipc-${i}`,
      `${process.env.TMPDIR ?? "/tmp"}/discord-ipc-${i}`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function readStatus(): { details: string; state: string } {
  if (STATIC_DETAILS) return { details: STATIC_DETAILS, state: "loom-desk" };
  try {
    if (!existsSync(STATUS_FILE)) return { details: "on standby", state: "loom-desk" };
    const raw = readFileSync(STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { details?: string; state?: string };
    return {
      details: parsed.details ?? "working on something",
      state: parsed.state ?? "loom-desk",
    };
  } catch {
    return { details: "working on something", state: "loom-desk" };
  }
}

// ── core ─────────────────────────────────────────────────────────────────────

class DiscordRPC {
  private socket: ReturnType<typeof connect> | null = null;
  private connected = false;
  private startTimestamp = Math.floor(Date.now() / 1000);
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private buffer = Buffer.alloc(0);

  async connect(): Promise<void> {
    const path = findIpcPath();
    if (!path) throw new Error("Discord IPC socket not found — is Discord running?");

    return new Promise((resolve, reject) => {
      const sock = connect(path);
      this.socket = sock;

      sock.on("connect", () => {
        console.log(`[rpc] connected to Discord IPC at ${path}`);
        // send handshake
        sock.write(encode(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
      });

      sock.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer(resolve);
      });

      sock.on("error", (err) => {
        if (!this.connected) reject(err);
        else console.error("[rpc] socket error:", err.message);
      });

      sock.on("close", () => {
        console.log("[rpc] Discord disconnected");
        this.connected = false;
        this.stopUpdates();
      });
    });
  }

  private processBuffer(onReady?: (value: void) => void) {
    while (this.buffer.length >= 8) {
      const op = this.buffer.readUInt32LE(0);
      const len = this.buffer.readUInt32LE(4);
      if (this.buffer.length < 8 + len) break;

      const raw = this.buffer.slice(8, 8 + len).toString("utf8");
      this.buffer = this.buffer.slice(8 + len);

      if (op === OP_PING) {
        this.socket?.write(encode(OP_PONG, {}));
        continue;
      }

      try {
        const msg = JSON.parse(raw) as { cmd?: string; evt?: string; data?: unknown };
        console.log(`[rpc] <- op=${op} cmd=${msg.cmd ?? ""} evt=${msg.evt ?? ""}`);
        if (msg.evt === "READY" && !this.connected) {
          this.connected = true;
          console.log("[rpc] handshake complete");
          this.setActivity();
          this.startUpdates();
          onReady?.();
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  private send(payload: unknown) {
    if (!this.socket || !this.connected) return;
    this.socket.write(encode(OP_FRAME, payload));
  }

  setActivity() {
    const { details, state } = readStatus();
    const activity = {
      details,
      state,
      timestamps: { start: this.startTimestamp },
      assets: {
        large_image: LARGE_IMAGE,
        large_text: "beckett",
        small_image: LARGE_IMAGE,
        small_text: "active",
      },
      instance: false,
    };
    this.send({
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity },
      nonce: randomUUID(),
    });
    console.log(`[rpc] activity set: "${details}" / "${state}"`);
  }

  private startUpdates() {
    this.updateTimer = setInterval(() => this.setActivity(), 15_000);
  }

  private stopUpdates() {
    if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }
  }

  disconnect() {
    this.stopUpdates();
    this.socket?.destroy();
  }
}

// ── main loop ─────────────────────────────────────────────────────────────────

const RETRY_DELAY_MS = 15_000;

async function run() {
  console.log(`[rpc] starting — client_id=${CLIENT_ID}`);
  while (true) {
    const rpc = new DiscordRPC();
    try {
      await rpc.connect();
      // keep alive — reconnect loop handles restart
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!(rpc as unknown as { connected: boolean }).connected) {
            clearInterval(check); resolve();
          }
        }, 5000);
      });
    } catch (err) {
      console.log(`[rpc] ${err instanceof Error ? err.message : err} — retrying in ${RETRY_DELAY_MS / 1000}s`);
    } finally {
      rpc.disconnect();
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

run().catch((e) => { console.error("[rpc] fatal:", e); process.exit(1); });
