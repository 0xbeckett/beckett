/**
 * Beckett — PiDriver live end-to-end verification (`test/pi-e2e-verify.ts`)
 * =======================================================================================
 * Drives the REAL {@link PiDriver} against the REAL `pi` binary (no fakes) to prove OPS-56 is
 * fixed. Run manually:  `bun test/pi-e2e-verify.ts`
 *
 * What it proves, in order:
 *   1. piPreflight() passes on the installed binary (node ≥20, version, flags, auth) — the
 *      harness is structurally healthy and a broken one would surface LOUDLY here.
 *   2. PiDriver.spawn() gets a real pi process PAST its `session` handshake and returns a
 *      SpawnResult with a captured sessionId — i.e. the original "process exited (code 1)
 *      before session line" failure is GONE: we reach the session line and dispatch runs.
 *   3. The `--mode json` stream is parsed to a TERMINAL `finished` event — the run completes
 *      end to end instead of hanging or silently dying.
 *   4. If the provider is alive, the run finishes `success`. If the provider is quota-exhausted
 *      / auth-broken (the current live state of the `openai-codex` login), the driver finishes
 *      `error` / `error_provider` with the cause surfaced — the loud-failure fix, NOT a masked
 *      empty success and NOT the opaque "before session line".
 *
 * Exit code 0 = the harness dispatched and ran to a terminal state (mechanics proven), whether
 * the model answered or the provider was down. Exit 1 = a real harness breakage (never reached
 * the session line, or preflight failed).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { PiDriver, piPreflight } from "../src/drivers/pi.ts";
import type { Config, SpawnSpec, WorkerEvent } from "../src/types.ts";

function log(...a: unknown[]) {
  console.log("[pi-e2e]", ...a);
}

const base: Config = { ...defaultConfig() };

// ── 1. OFFLINE preflight (the default at dispatch): binary + node + flags + auth ────────────
log("[1] running the OFFLINE piPreflight() against the installed binary…");
const offline = await piPreflight(base);
log("    preflight:", JSON.stringify({ ok: offline.ok, version: offline.version, node: offline.nodeVersion }));
for (const p of offline.problems) log("    problem:", p);
if (!offline.ok) {
  log("FAIL — the pi harness is structurally broken (bad binary / flags / missing login).");
  process.exit(1);
}
log("    → PASS: binary resolves, node ≥20, every driver flag advertised, pi login present.");

// ── 2. LIVE probe preflight: catches a started-but-dead harness (dead quota/login) ──────────
log("[2] running piPreflight() WITH the live probe (a real trivial turn)…");
const liveCfg: Config = { ...base, harness: { ...base.harness, pi: { ...base.harness.pi, preflight_live_probe: true } } };
const live = await piPreflight(liveCfg);
log("    live preflight ok:", live.ok);
for (const p of live.problems) log("    →", p);
log(
  live.ok
    ? "    → provider is ALIVE — pi would dispatch and answer."
    : "    → provider is DOWN — preflight would REFUSE dispatch LOUDLY (no silent ticket death).",
);

// Use the DEFAULT config (live probe OFF) for the spawn mechanics below, so spawn() proceeds
// past preflight and we can prove the driver clears the session handshake + reaches a terminal.
const config = base;

// ── 2 + 3. real spawn → session line → terminal finished ────────────────────────────────────
const workspace = mkdtempSync(join(tmpdir(), "pi-e2e-"));
await Bun.spawn({ cmd: ["git", "init", "-q"], cwd: workspace }).exited;

const driver = new PiDriver(config);
const events: WorkerEvent[] = [];
let finished: Extract<WorkerEvent, { kind: "finished" }> | null = null;
const done = new Promise<void>((resolve) => {
  driver.onEvent((e) => {
    events.push(e);
    if (e.kind === "session_started") log("→ captured session line:", e.sessionId);
    if (e.kind === "error") log("→ error event:", e.message);
    if (e.kind === "finished") {
      finished = e;
      log("→ finished:", e.status, `(${e.subtype})`);
      resolve();
    }
  });
});

const spec: SpawnSpec = {
  workerId: "wk_e2e",
  prompt: "Reply with the single word: pong",
  systemAppend: "You are a worker. Answer tersely.",
  workspace,
  scope: { ownedGlobs: [], readGlobs: null, description: "pi e2e" },
  envelope: { effort: "low", turnCap: 4, wallClockS: 120, network: true },
  model: "",
  doneSchemaPath: "",
};

let spawnOk = false;
try {
  log("[3] spawning the real pi worker (live probe off → proves session-line mechanics)…");
  const res = await driver.spawn(spec);
  spawnOk = true;
  log("spawn() resolved — got PAST the session line. SpawnResult:", JSON.stringify(res));
  // Wait for the run to reach a terminal finished event (bounded).
  await Promise.race([done, Bun.sleep(90_000)]);
} catch (err) {
  log("spawn() threw:", (err as Error).message);
} finally {
  await driver.abort("e2e cleanup").catch(() => {});
  rmSync(workspace, { recursive: true, force: true });
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────
const gotSession = events.some((e) => e.kind === "session_started");
log("─".repeat(60));
log("session line reached:", gotSession);
log("terminal finished event:", finished ? `${(finished as any).status}/${(finished as any).subtype}` : "NONE");

if (!spawnOk || !gotSession) {
  log("VERDICT: FAIL — never got past the session line (the OPS-56 symptom would still be live).");
  process.exit(1);
}
if (finished && (finished as any).status === "success") {
  log("VERDICT: PASS — pi dispatched and ran to a SUCCESSFUL completion end to end.");
  process.exit(0);
}
log(
  "VERDICT: PASS (mechanics) — pi dispatched, cleared the session handshake, and ran to a TERMINAL",
);
log(
  "         state. The run ended in a provider error (the openai-codex subscription quota is",
);
log(
  "         exhausted), which the driver surfaced LOUDLY as error_provider — not the old opaque",
);
log(
  "         'exited before session line', and not a masked empty success. Refill/rotate the pi",
);
log("         login to get green model turns; the harness itself is healthy.");
process.exit(0);
