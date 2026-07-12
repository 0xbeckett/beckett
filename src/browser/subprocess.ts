import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";

export interface SpawnOptions {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: "pipe" | "ignore";
  stdout: "pipe" | "ignore";
  stderr: "pipe" | "ignore";
  detached: boolean;
}

export interface SpawnedProcess {
  readonly pid: number;
  readonly stdin: { write(value: string | Uint8Array): unknown; end(): unknown } | number | null | undefined;
  readonly stdout: ReadableStream<Uint8Array> | number | null | undefined;
  readonly stderr: ReadableStream<Uint8Array> | number | null | undefined;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnProcess = (options: SpawnOptions) => SpawnedProcess;

/** Use Bun's fast subprocess API in the daemon and a small Node adapter in the controller host. */
export const spawnSubprocess: SpawnProcess = (options) => {
  if (typeof Bun !== "undefined") return Bun.spawn(options) as unknown as SpawnedProcess;

  const child = nodeSpawn(options.cmd[0]!, options.cmd.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: [options.stdin, options.stdout, options.stderr],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return {
    get pid() {
      return child.pid ?? -1;
    },
    stdin: child.stdin,
    stdout: child.stdout ? Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array> : null,
    stderr: child.stderr ? Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array> : null,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    kill(signal = "SIGTERM") {
      return child.kill(signal);
    },
  };
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
