/**
 * Beckett v2 — control bus (`src/shell/control-bus.ts`)
 * =======================================================================================
 * The thin request/response channel between the `beckett` CLI (which the parent agent runs
 * via Bash) and the long-lived shell process that holds the live worker handles + the
 * parent's stdin pipe (Spec 05). A unix-domain socket, one request per connection, framed
 * with a 4-byte big-endian length prefix + UTF-8 JSON.
 *
 * This is deliberately self-contained (no dependency on the v0.1 IPC command union, which is
 * being deleted): the envelope is just `{cmd, args}` → `{ok, data?, error?}`. The shell owns
 * the command vocabulary; the CLI is a dumb forwarder.
 */

import { existsSync, unlinkSync } from "node:fs";

const HEADER = 4;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface BusRequest {
  cmd: string;
  args: Record<string, unknown>;
}
export interface BusResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The caller did not receive a response before its deadline, so the outcome is unknown: the daemon
 * may still be working on it (and, for a Discord reply, may already have posted it). Callers must not turn this
 * into an automatic retry of a side-effecting command.
 */
export class ControlBusTimeoutError extends Error {
  readonly code = "CONTROL_BUS_TIMEOUT";
  constructor(readonly timeoutMs: number) {
    super(`control bus timeout after ${timeoutMs}ms`);
    this.name = "ControlBusTimeoutError";
  }
}

function frame(value: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(HEADER + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, HEADER);
  return out;
}

/** Decode exactly one length-prefixed frame from an accumulating buffer. */
class OneFrame {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): unknown | undefined {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    if (this.buf.length < HEADER) return undefined;
    const len = new DataView(this.buf.buffer, this.buf.byteOffset, HEADER).getUint32(0, false);
    if (this.buf.length < HEADER + len) return undefined;
    try {
      return JSON.parse(dec.decode(this.buf.subarray(HEADER, HEADER + len)));
    } catch {
      return undefined;
    }
  }
}

export type BusHandler = (req: BusRequest) => Promise<BusResponse> | BusResponse;

/** Listen on a unix socket; dispatch each `{cmd,args}` to `handler`. Returns a stop fn. */
export function serveBus(socketPath: string, handler: BusHandler): () => void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* stale socket */
    }
  }
  const frames = new WeakMap<object, OneFrame>();
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(sock, data) {
        let fd = frames.get(sock);
        if (!fd) frames.set(sock, (fd = new OneFrame()));
        const msg = fd.push(data);
        if (msg === undefined) return;
        const req = msg as BusRequest;
        Promise.resolve(handler(req))
          .then((res) => sock.write(frame(res)))
          .catch((err) => sock.write(frame({ ok: false, error: String(err?.message ?? err) })))
          .finally(() => queueMicrotask(() => sock.end()));
      },
    },
  });
  return () => {
    try {
      server.stop(true);
    } catch {
      /* best-effort */
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
    }
  };
}

/** One-shot client call from the CLI to the shell. Rejects if the socket is absent/refused. */
export function callBus(
  socketPath: string,
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<BusResponse> {
  return new Promise((resolve, reject) => {
    const fd = new OneFrame();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new ControlBusTimeoutError(timeoutMs))),
      timeoutMs,
    );
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(frame({ cmd, args }));
        },
        data(sock, data) {
          const msg = fd.push(data);
          if (msg === undefined) return;
          clearTimeout(timer);
          sock.end();
          done(() => resolve(msg as BusResponse));
        },
        error(_sock, err) {
          clearTimeout(timer);
          done(() => reject(err));
        },
        connectError(_sock, err) {
          clearTimeout(timer);
          done(() =>
            reject(new Error(`shell not running (socket ${socketPath}): ${err?.message ?? err}`)),
          );
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
  });
}
