/**
 * Beckett — IPC wire protocol (`src/ipc/protocol.ts`)
 * =======================================================================================
 * The shared contract for the CLI↔daemon write channel (Spec 01 §7, Spec 10 §8). BOTH the
 * client (this phase, `./client.ts`) and the daemon-side server (the Spine phase's
 * `IpcServer`) import their framing + envelope helpers from here, so the two halves can
 * never drift out of agreement.
 *
 * Transport (Spec 10 §8.1): a unix-domain socket, **one request per connection**, framed
 * with a **4-byte big-endian uint32 length prefix** followed by that many bytes of UTF-8
 * JSON. The length prefix is preferred over newline-delimiting precisely so multi-line
 * `reason`/`diff` payloads never need escaping. The response is framed identically; then the
 * daemon closes the connection.
 *
 * The request/response envelopes ({@link IpcRequest}/{@link IpcResponse}) and the command
 * union ({@link IpcCmd}) are the FROZEN CONTRACT — imported from `src/types.ts`, never
 * redefined. This module owns only the *framing*, the request builder, and the CLI exit-code
 * map (Spec 10 §1.4) the two layers share.
 *
 * Import style: explicit `.ts` extensions (Foundation contract).
 */

import type { IpcRequest, IpcResponse, IpcCmd } from "../types.ts";
import { requestId } from "../ids.ts";

export type { IpcRequest, IpcResponse, IpcCmd } from "../types.ts";

/** The IPC protocol major version carried on every envelope (Spec 10 §8.1). */
export const PROTO = 1 as const;

/** Bytes reserved for the big-endian uint32 frame-length prefix. */
const HEADER_BYTES = 4;

/**
 * CLI exit codes (Spec 10 §1.4) — shared so the client maps transport failures and the
 * dispatcher maps daemon `error.exit` to the same vocabulary.
 */
export const EXIT = {
  OK: 0,
  RUNTIME: 1, // generic runtime error
  USAGE: 2, // bad/missing args, unknown command/flag, unresolvable id syntax
  DAEMON_DOWN: 3, // socket missing/refused on a write command
  NOT_FOUND: 4, // id resolved syntactically but doesn't exist / isn't live
  REJECTED: 5, // command valid but illegal in the target's current state
  USER_ABORT: 6, // a confirmation prompt was declined
  TIMEOUT: 7, // socket request exceeded --timeout
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A transport/dispatch failure carrying the exact CLI exit code to use (Spec 10 §1.4/§8.3).
 * The daemon stays the authority on *why* a command was rejected; the client raises this for
 * connect/timeout failures, and the dispatcher re-raises a daemon `error` as one of these.
 */
export class IpcError extends Error {
  constructor(
    readonly exit: ExitCode,
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Frame an envelope into `[uint32 length][utf8 json]` ready to write to the socket. */
export function encodeFrame(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value));
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false); // big-endian
  frame.set(body, HEADER_BYTES);
  return frame;
}

/**
 * Accumulates raw socket bytes and yields each complete framed message. One per connection
 * is the norm, but the decoder tolerates partial reads (TCP-style chunking on the unix
 * socket) and is reusable across both client and server.
 */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  /** Push a chunk; returns every fully-received JSON value it now contains. */
  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: unknown[] = [];
    while (this.buf.length >= HEADER_BYTES) {
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        HEADER_BYTES,
      ).getUint32(0, false);
      if (this.buf.length < HEADER_BYTES + len) break;
      const body = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
      const text = decoder.decode(body);
      this.buf = this.buf.slice(HEADER_BYTES + len);
      try {
        out.push(JSON.parse(text));
      } catch {
        // A corrupt frame is skipped rather than throwing (forward-compat discipline).
      }
    }
    return out;
  }
}

/** Build a well-formed {@link IpcRequest} with a fresh correlation id (Spec 10 §8.2). */
export function makeRequest(
  cmd: IpcCmd,
  args: Record<string, unknown>,
  userId: string,
): IpcRequest {
  return { proto: PROTO, request_id: requestId(), cmd, args, user_id: userId };
}

/** Runtime guard: is `x` shaped like an {@link IpcResponse} (Spec 10 §8.3)? */
export function isIpcResponse(x: unknown): x is IpcResponse {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.proto === PROTO && typeof r.ok === "boolean" && typeof r.request_id === "string";
}
