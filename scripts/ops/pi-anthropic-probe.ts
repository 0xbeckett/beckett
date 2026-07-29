#!/usr/bin/env bun

/**
 * Beckett — pi ⇄ anthropic routing probe (`scripts/ops/pi-anthropic-probe.ts`, #121)
 * =======================================================================================
 * The live check behind cast-level provider routing. #121 makes pi the default harness and
 * reaches the Claude models through pi's `anthropic` provider instead of claude-the-CLI, which
 * is only safe if TWO things are true against the real binary — so this probe proves both
 * rather than asserting them in a unit test that mocks the thing under question:
 *
 *   1. ROUTING — a cast of `{"harness":"pi","provider":"anthropic","model":"claude-opus-5"}`
 *      spawns through the REAL {@link PiDriver} (argv, `--mode json` stream, session handshake,
 *      done-signal parse) and comes back with a real completion from the real model.
 *   2. EYES — pi forwards IMAGE content through to the model. If it didn't, every visual ticket
 *      (mockups, screenshots, the browser lane) would silently lose Opus's eyes the moment the
 *      default flipped. Two paths are probed separately because they are different code paths:
 *        a. `@file.png` attachment on the command line;
 *        b. the agent's own `read` tool on an image file — the path a worker actually takes when
 *           it screenshots a page and looks at the result.
 *      The image is generated HERE at run time with a phrase that exists only as PIXELS, so a
 *      correct answer cannot come from filename, metadata, or byte-scraping.
 *
 * Auth: pi's `anthropic` provider takes the Claude subscription OAuth token via `ANTHROPIC_API_KEY`.
 * The probe uses `$ANTHROPIC_API_KEY` when set, else the local Claude Code login
 * (`~/.claude/.credentials.json`). The token is injected into the child env and never printed.
 * NOTE this is exactly the gap the daemon still has: `src/env.ts#childEnv` strips `ANTHROPIC_*`
 * from every worker child (subscription-auth-only rule), so a dispatched pi worker gets no
 * anthropic credential yet. The probe overrides the child env for that ONE reason; wiring the
 * credential into the daemon's own workers is a separate ticket.
 *
 * Usage:
 *   bun scripts/ops/pi-anthropic-probe.ts                 # both probes, claude-opus-5
 *   bun scripts/ops/pi-anthropic-probe.ts --model claude-fable-5
 *   bun scripts/ops/pi-anthropic-probe.ts --only images   # or: --only routing
 *   bun scripts/ops/pi-anthropic-probe.ts --json          # machine-readable report
 *
 * Requires: `pi` on PATH, ImageMagick's `convert` (image probes only), a live Claude login.
 * Exit code 0 ⇒ every requested probe passed; 1 ⇒ at least one did not (the report says which).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { validateConfig } from "../../src/config.ts";
import { PiDriver } from "../../src/drivers/pi.ts";
import { childEnv } from "../../src/env.ts";
import type { Config, Logger, SpawnSpec, WorkerEvent } from "../../src/types.ts";

// ── args ────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODEL = flag("model") ?? "claude-opus-5";
const PROVIDER = flag("provider") ?? "anthropic";
const ONLY = flag("only"); // "routing" | "images" | undefined (both)
const AS_JSON = argv.includes("--json");

const say = (line: string) => process.stderr.write(`${line}\n`);
const quietLogger = (() => {
  const emit = (level: string) => (msg: unknown, meta?: unknown) => {
    if (!AS_JSON) say(`  [${level}] ${String(msg)}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  };
  const log = { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: () => {}, child() { return log; } };
  return log as unknown as Logger;
})();

// ── auth ────────────────────────────────────────────────────────────────────────────────

/**
 * The Claude subscription OAuth token pi's `anthropic` provider authenticates with. Read from the
 * env first, else from the local Claude Code login. Returned as a value that is only ever put in
 * a child env — never logged, never written to the report.
 */
function anthropicToken(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = join(process.env.HOME ?? "", ".claude/.credentials.json");
  try {
    const creds = JSON.parse(readFileSync(path, "utf8")) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const token = creds.claudeAiOauth?.accessToken?.trim();
    if (!token) throw new Error("no claudeAiOauth.accessToken");
    const expiresAt = creds.claudeAiOauth?.expiresAt;
    if (expiresAt && expiresAt < Date.now()) {
      say(`! the Claude login at ${path} expired at ${new Date(expiresAt).toISOString()} — re-login first`);
    }
    return token;
  } catch (err) {
    throw new Error(
      `no anthropic credential: set ANTHROPIC_API_KEY, or sign in with Claude Code (${path}): ${(err as Error).message}`,
    );
  }
}

/** The env a probe child runs under: the daemon's child env + the anthropic OAuth token. */
function probeEnv(token: string): Record<string, string | undefined> {
  const env = childEnv();
  const home = process.env.HOME ?? "";
  env.PATH = [join(home, ".local/bin"), join(home, ".bun/bin"), env.PATH].filter(Boolean).join(":");
  env.ANTHROPIC_API_KEY = token;
  return env;
}

// ── the pixel-only test image ───────────────────────────────────────────────────────────

interface ProbeImage {
  path: string;
  /** The phrase rendered into the pixels — it exists NOWHERE else (not the filename, not metadata). */
  phrase: string;
  shape: "circle" | "square" | "triangle";
  /** Human colour names the answer is scored against. */
  colors: [string, string];
}

const SHAPES = ["circle", "square", "triangle"] as const;

/** Render a fresh image whose content can only be recovered by LOOKING at it. */
function makeProbeImage(dir: string, index: number): ProbeImage {
  const phrase = `${["MULBERRY", "HALCYON", "ZEPHYR", "OBSIDIAN"][index % 4]} ${randomBytes(2).readUInt16BE(0) % 9000 + 1000}`;
  const shape = SHAPES[index % SHAPES.length]!;
  const path = join(dir, `probe-${index}.png`);
  const draw =
    shape === "circle" ? "circle 200,210 200,120"
    : shape === "square" ? "rectangle 380,80 590,300"
    : "polygon 320,70 560,330 80,330";
  const result = Bun.spawnSync({
    cmd: [
      "convert", "-size", "640x420", "xc:#0B3D91",
      "-fill", "#FF7A1A", "-draw", draw,
      "-fill", "white", "-pointsize", "46", "-annotate", "+50+395", phrase,
      path,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    throw new Error(`could not render the probe image (ImageMagick \`convert\` required): ${result.stderr.toString()}`);
  }
  return { path, phrase, shape, colors: ["blue", "orange"] };
}

/** Did the model actually SEE the image? The phrase alone is the proof; shape/colour corroborate. */
function scoreVision(answer: string, image: ProbeImage): { sawPhrase: boolean; sawShape: boolean; sawColors: boolean } {
  const text = answer.toLowerCase();
  return {
    sawPhrase: text.includes(image.phrase.toLowerCase()),
    sawShape: text.includes(image.shape),
    sawColors: image.colors.every((c) => text.includes(c)),
  };
}

// ── probe 1: cast routing through the real PiDriver ──────────────────────────────────────

/**
 * A PiDriver whose child carries the anthropic OAuth token. The ONLY override — argv, parsing,
 * preflight and lifecycle are the production code paths, so this genuinely exercises the
 * `provider` threading added in #121 rather than a stand-in for it.
 */
class ProbePiDriver extends PiDriver {
  constructor(config: Config, logger: Logger, private readonly token: string) {
    super(config, logger);
  }
  protected override buildChildEnv(): Record<string, string | undefined> {
    return probeEnv(this.token);
  }
}

interface RoutingResult {
  ok: boolean;
  provider: string;
  model: string;
  /** The model's own final message — the "real completion" the acceptance criterion asks for. */
  answer: string;
  sessionModel: string | null;
  finishStatus: string | null;
  detail?: string;
}

async function probeRouting(dir: string, token: string): Promise<RoutingResult> {
  const config = validateConfig({});
  const driver = new ProbePiDriver(config, quietLogger, token);
  const events: WorkerEvent[] = [];
  driver.onEvent((e) => events.push(e));

  const doneSchemaPath = join(dir, "done-schema.json");
  writeFileSync(doneSchemaPath, JSON.stringify({ type: "object" }));
  const marker = `PI-ANTHROPIC-${randomBytes(3).toString("hex").toUpperCase()}`;
  const spec: SpawnSpec = {
    workerId: "probe",
    prompt:
      `Answer in one line, with no tool calls: repeat this token back exactly — ${marker} — ` +
      `and then name the model you are.`,
    systemAppend: "You are a routing probe. Answer in one short line.",
    workspace: dir,
    scope: { ownedGlobs: [], readGlobs: [], denyGlobs: [] } as unknown as SpawnSpec["scope"],
    envelope: { effort: "low", turnCap: 2, wallClockS: 120, network: true },
    model: MODEL,
    provider: PROVIDER,
    sessionId: randomUUID(),
    doneSchemaPath,
  };

  const finished = new Promise<WorkerEvent | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 300_000);
    driver.onEvent((e) => {
      if (e.kind === "finished") {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });

  await driver.spawn(spec);
  const finish = await finished;
  const answer = events
    .filter((e): e is Extract<WorkerEvent, { kind: "assistant_text" }> => e.kind === "assistant_text")
    .map((e) => e.text)
    .join("\n")
    .trim();
  const session = events.find((e) => e.kind === "session_started") as { model?: string } | undefined;
  const status = finish && finish.kind === "finished" ? finish.status : null;
  const ok = status === "success" && answer.includes(marker);
  return {
    ok,
    provider: PROVIDER,
    model: MODEL,
    answer,
    sessionModel: session?.model ?? null,
    finishStatus: status,
    detail: ok ? undefined : `expected a success finish echoing ${marker}`,
  };
}

// ── probe 2: does pi forward image content to the model? ─────────────────────────────────

interface ImageResult {
  ok: boolean;
  path: "attachment" | "read-tool";
  answer: string;
  score: ReturnType<typeof scoreVision>;
  /** The literal tool-result content shape pi produced (read-tool path only) — the evidence. */
  toolResultShape?: string;
  detail?: string;
}

const IMAGE_QUESTION =
  "Report exactly three things: (1) the text written in the image, verbatim; (2) the shape — " +
  "circle, square or triangle; (3) the two main colours as plain names. If no image reached you, " +
  "answer NO IMAGE RECEIVED and say what you got instead.";

/** Run pi non-interactively and return its raw `--mode json` stream lines. */
function runPi(args: string[], cwd: string, token: string): { lines: unknown[]; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync({
    cmd: ["pi", "-p", "--mode", "json", "--no-extensions", "--no-skills", "--no-themes",
      "--provider", PROVIDER, "--model", MODEL, "--thinking", "low", ...args],
    cwd,
    env: probeEnv(token),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  const lines: unknown[] = [];
  for (const raw of proc.stdout.toString().split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      /* pi is tolerant by contract; so is the probe */
    }
  }
  return { lines, stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

/** The concatenated assistant text of a `--mode json` run. */
function assistantText(lines: unknown[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const o = line as { type?: string; message?: { role?: string; content?: { type?: string; text?: string }[] } };
    if (o.type !== "message_end" || o.message?.role !== "assistant") continue;
    for (const block of o.message.content ?? []) if (block.type === "text" && block.text) out.push(block.text);
  }
  return out.join("\n").trim();
}

/** Probe (a): the image is attached on the command line; tools are OFF so ONLY pixels can answer. */
function probeAttachment(dir: string, token: string, image: ProbeImage): ImageResult {
  const { lines, stderr, exitCode } = runPi(["--no-tools", `@${image.path}`, IMAGE_QUESTION], dir, token);
  const answer = assistantText(lines);
  const score = scoreVision(answer, image);
  return {
    ok: score.sawPhrase,
    path: "attachment",
    answer,
    score,
    detail: score.sawPhrase ? undefined : `exit ${exitCode}; stderr: ${stderr.trim().slice(0, 400)}`,
  };
}

/**
 * Probe (b): the agent reads the image ITSELF with its `read` tool — the worker-realistic path
 * (screenshot → look at it). Also captures the literal tool-result content shape, which is where
 * an image would be dropped if pi turned it into a text stub.
 */
function probeReadTool(dir: string, token: string, image: ProbeImage): ImageResult {
  const prompt =
    `Use your read tool on the file ${image.path.split("/").pop()} in the current directory, then ` +
    IMAGE_QUESTION;
  const { lines, stderr, exitCode } = runPi([prompt], dir, token);
  const answer = assistantText(lines);
  const score = scoreVision(answer, image);

  // The evidence, not a guess: what the read tool actually handed back.
  let shape: string | undefined;
  for (const line of lines) {
    const o = line as { type?: string; toolName?: string; result?: { content?: { type?: string; data?: string }[] } };
    if (o.type !== "tool_execution_end" || o.toolName !== "read") continue;
    shape = JSON.stringify(
      (o.result?.content ?? []).map((b) =>
        b.type === "image" ? { type: "image", data: `<base64 ${(b.data ?? "").length} chars>` } : b,
      ),
    );
  }

  return {
    ok: score.sawPhrase,
    path: "read-tool",
    answer,
    score,
    toolResultShape: shape,
    detail: score.sawPhrase ? undefined : `exit ${exitCode}; stderr: ${stderr.trim().slice(0, 400)}`,
  };
}

// ── main ────────────────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "beckett-pi-anthropic-probe-"));
const report: Record<string, unknown> = { model: MODEL, provider: PROVIDER };
let failures = 0;
try {
  const token = anthropicToken();

  if (ONLY !== "images") {
    say(`▸ routing: pi --provider ${PROVIDER} --model ${MODEL}, through the real PiDriver…`);
    const routing = await probeRouting(dir, token);
    report.routing = routing;
    failures += routing.ok ? 0 : 1;
    say(`  ${routing.ok ? "PASS" : "FAIL"} — finish=${routing.finishStatus} answer=${JSON.stringify(routing.answer.slice(0, 160))}`);
  }

  if (ONLY !== "routing") {
    const attachmentImage = makeProbeImage(dir, 0);
    say(`▸ images (attachment): does @file.png reach ${MODEL}?`);
    const attachment = probeAttachment(dir, token, attachmentImage);
    report.attachment = { ...attachment, groundTruth: attachmentImage.phrase };
    failures += attachment.ok ? 0 : 1;
    say(`  ${attachment.ok ? "PASS" : "FAIL"} — ${JSON.stringify(attachment.answer.slice(0, 240))}`);

    const readImage = makeProbeImage(dir, 1);
    say(`▸ images (read tool): does the agent's own read of a PNG reach ${MODEL}?`);
    const readTool = probeReadTool(dir, token, readImage);
    report.readTool = { ...readTool, groundTruth: readImage.phrase };
    failures += readTool.ok ? 0 : 1;
    say(`  ${readTool.ok ? "PASS" : "FAIL"} — tool result: ${readTool.toolResultShape ?? "(no read tool call)"}`);
    say(`  ${JSON.stringify(readTool.answer.slice(0, 240))}`);
  }
} catch (err) {
  report.error = (err as Error).message;
  failures += 1;
  say(`! ${(err as Error).message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (AS_JSON) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
say(failures === 0 ? "\nAll probes PASSED." : `\n${failures} probe(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
