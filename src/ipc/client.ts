/**
 * Beckett — IPC client half (`src/ipc/client.ts`)
 * =======================================================================================
 * The CLI's write-channel transport (Spec 01 §7, Spec 10 §8.5): connect to the daemon's
 * unix-domain socket, send ONE length-framed {@link IpcRequest}, read ONE framed
 * {@link IpcResponse}, then close. Implements the frozen {@link IpcClient} interface.
 *
 * Failure model is honest and load-bearing (Spec 10 §8.5):
 *   - socket absent (`ENOENT`) or stale (`ECONNREFUSED`) → {@link IpcError} exit 3
 *     ("daemon not running — start it with 'beckett daemon start'"). The client NEVER
 *     deletes the socket file (that's the daemon's, unlinked on next startup).
 *   - no response within the timeout → {@link IpcError} exit 7, with the "may have been
 *     accepted — check 'beckett ps'" caveat (nudge de-dupe makes a retry safe, Spec 03 §6.2).
 *
 * Uses Bun's native `Bun.connect` unix-socket support (the runtime is Bun, Spec 00).
 */

import type { IpcRequest, IpcResponse, IpcClient } from "../types.ts";
import { encodeFrame, FrameDecoder, isIpcResponse, IpcError, EXIT } from "./protocol.ts";

export interface IpcClientOptions {
  /** Absolute path to the daemon's unix socket (`[paths].socket`). */
  socketPath: string;
  /** Per-request timeout in ms (Spec 10 §1.2 `--timeout`, default 5000). */
  timeoutMs?: number;
}

/** Map a Node/Bun connect error to the right CLI exit code (Spec 10 §8.5). */
function mapConnError(err: unknown): IpcError {
  const code = (err as { code?: string } | null)?.code;
  const msg = String((err as { message?: string } | null)?.message ?? err);
  if (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    /ENOENT|ECONNREFUSED|connection refused|no such file/i.test(msg)
  ) {
    return new IpcError(
      EXIT.DAEMON_DOWN,
      "daemon_down",
      "daemon not running — start it with 'beckett daemon start'",
    );
  }
  return new IpcError(EXIT.RUNTIME, "internal", `IPC transport error: ${msg}`);
}

/** The single-shot, length-framed unix-socket client (Spec 10 §8). */
export class UnixIpcClient implements IpcClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(opts: IpcClientOptions) {
    this.socketPath = opts.socketPath;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  send(req: IpcRequest): Promise<IpcResponse> {
    return new Promise<IpcResponse>((resolve, reject) => {
      const decoder = new FrameDecoder();
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          try {
            sock?.end();
          } catch {
            /* best-effort close */
          }
          reject(
            new IpcError(
              EXIT.TIMEOUT,
              "timeout",
              `timed out waiting for the daemon after ${this.timeoutMs}ms; ` +
                "the command may have been accepted — check 'beckett ps'",
            ),
          );
        });
      }, this.timeoutMs);

      let sock: { end(): void; write(data: Uint8Array): number } | null = null;

      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(s) {
            try {
              s.write(encodeFrame(req));
            } catch (e) {
              finish(() => reject(mapConnError(e)));
            }
          },
          data(s, chunk: Uint8Array) {
            for (const msg of decoder.push(chunk)) {
              if (isIpcResponse(msg)) {
                finish(() => {
                  try {
                    s.end();
                  } catch {
                    /* best-effort close */
                  }
                  resolve(msg);
                });
                return;
              }
            }
          },
          error(_s, err) {
            finish(() => reject(mapConnError(err)));
          },
          close() {
            finish(() =>
              reject(
                new IpcError(
                  EXIT.DAEMON_DOWN,
                  "daemon_down",
                  "daemon closed the connection without a response",
                ),
              ),
            );
          },
        },
      })
        .then((s) => {
          sock = s;
        })
        .catch((err) => {
          finish(() => reject(mapConnError(err)));
        });
    });
  }
}

export type { IpcClient } from "../types.ts";
