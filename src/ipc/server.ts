/**
 * Beckett — IPC server half (`src/ipc/server.ts`)
 * =======================================================================================
 * The daemon-side unix-domain socket listener (Spec 01 §7; Spec 10 §8). Pairs with the
 * client (`./client.ts`) + the shared wire framing (`./protocol.ts`): it accepts ONE
 * length-framed {@link IpcRequest} per connection, hands it to the daemon's dispatch
 * `handler`, writes back ONE framed {@link IpcResponse}, then closes the connection.
 *
 * WRITE commands only (Spec 01 §7): reads (`ps`/`tail`/`logs`/`status`-snapshot) go straight
 * to the DB on the CLI side and never reach this socket. The handler the daemon supplies maps
 * `nudge`/`pause`/`resume`/`abort`/`ask_plan`/`reload`/`status`/`shutdown` onto the live worker
 * handles via the Orchestrator/WorkerManager.
 *
 * Boot hygiene (Spec 01 §5.1 step 5): a stale socket file from a crashed prior run is unlinked
 * before binding, so the daemon always owns a fresh socket. The framing is shared with the
 * client through {@link encodeFrame}/{@link FrameDecoder} so the two halves can never drift.
 */

import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IpcServer, IpcRequest, IpcResponse, Logger } from "../types.ts";
import { log as rootLog } from "../log.ts";
import { encodeFrame, FrameDecoder, isIpcResponse, PROTO } from "./protocol.ts";

export interface IpcServerOptions {
  /** Absolute path to the unix socket (`[paths].socket`). */
  socketPath: string;
  logger?: Logger;
}

/** Minimal shape of a Bun unix socket connection we use. */
interface BunSocket {
  write(data: Uint8Array): number;
  end(): void;
  data: { decoder: FrameDecoder; handled: boolean };
}

/** The unix-socket {@link IpcServer} over Bun's native `Bun.listen`. */
export class UnixIpcServer implements IpcServer {
  private readonly socketPath: string;
  private readonly logger: Logger;
  private server: { stop(closeActiveConnections?: boolean): void } | null = null;

  constructor(opts: IpcServerOptions) {
    this.socketPath = opts.socketPath;
    this.logger = (opts.logger ?? rootLog).child("ipc");
  }

  /** Bind the socket and dispatch each request through `handler` (Spec 10 §8.4). */
  async start(handler: (req: IpcRequest) => Promise<IpcResponse>): Promise<void> {
    // Unlink a stale socket from a crashed prior run before binding (Spec 01 §5.1 step 5).
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        this.logger.warn("could not unlink stale socket", { error: (err as Error).message });
      }
    }

    const logger = this.logger;
    this.server = Bun.listen<BunSocket["data"]>({
      unix: this.socketPath,
      socket: {
        open(socket) {
          socket.data = { decoder: new FrameDecoder(), handled: false };
        },
        data(socket, chunk: Uint8Array) {
          const state = socket.data;
          for (const msg of state.decoder.push(chunk)) {
            if (state.handled) return; // one request per connection (Spec 10 §8.1)
            state.handled = true;
            void dispatch(socket as unknown as BunSocket, msg, handler, logger);
          }
        },
        error(_socket, err) {
          logger.debug("ipc connection error", { error: String(err) });
        },
      },
    });
    this.logger.info("ipc listening", { socket: this.socketPath });
  }

  async stop(): Promise<void> {
    try {
      this.server?.stop(true);
    } catch {
      /* best-effort */
    }
    this.server = null;
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* best-effort */
      }
    }
    this.logger.info("ipc stopped");
  }
}

/** Validate, dispatch, frame the reply, and close — never let a handler throw kill the daemon. */
async function dispatch(
  socket: BunSocket,
  msg: unknown,
  handler: (req: IpcRequest) => Promise<IpcResponse>,
  logger: Logger,
): Promise<void> {
  let response: IpcResponse;
  try {
    if (!isIpcRequest(msg)) {
      response = errorResponse(
        (msg as { request_id?: string } | null)?.request_id ?? "",
        "proto_mismatch",
        "malformed IPC request (expected {proto:1, request_id, cmd, args, user_id})",
        2,
      );
    } else {
      response = await handler(msg);
    }
  } catch (err) {
    const rid = (msg as { request_id?: string } | null)?.request_id ?? "";
    logger.error("ipc handler threw", { error: (err as Error).message });
    response = errorResponse(rid, "internal", (err as Error).message, 1);
  }
  try {
    socket.write(encodeFrame(response));
  } catch (err) {
    logger.debug("ipc write failed", { error: String(err) });
  }
  try {
    socket.end();
  } catch {
    /* best-effort close */
  }
}

/** Runtime guard for an inbound {@link IpcRequest}. */
function isIpcRequest(x: unknown): x is IpcRequest {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    r.proto === PROTO &&
    typeof r.request_id === "string" &&
    typeof r.cmd === "string" &&
    typeof r.user_id === "string" &&
    typeof r.args === "object" &&
    r.args !== null
  );
}

/** Build a framed error {@link IpcResponse} with the CLI exit code (Spec 10 §8.3). */
export function errorResponse(
  requestId: string,
  kind: string,
  message: string,
  exit: number,
): IpcResponse {
  return { proto: PROTO, request_id: requestId, ok: false, error: { kind, message, exit } };
}

/** Build a framed success {@link IpcResponse}. */
export function okResponse(requestId: string, data?: unknown): IpcResponse {
  return { proto: PROTO, request_id: requestId, ok: true, data };
}

/** Convenience factory matching the codebase's `createX` style. */
export function createIpcServer(opts: IpcServerOptions): UnixIpcServer {
  return new UnixIpcServer(opts);
}

/** Compile-time check: UnixIpcServer satisfies the frozen IpcServer contract. */
const _serverCheck: new (o: IpcServerOptions) => IpcServer = UnixIpcServer;
void _serverCheck;
