/**
 * Beckett — stub harness binaries for the one-shot AGENT LANES (`src/test/lane-stubs.ts`)
 * =======================================================================================
 * The lane counterpart to {@link ./fake-harness.ts} (which fakes a long-lived, steerable ticket
 * WORKER). The lanes in {@link ../drivers/lane.ts} spawn a real subprocess and read its stdout, so
 * proving "this lane spawns under pi" means running something that (a) is invoked exactly the way
 * the lane invokes `pi`, and (b) answers in pi's `--mode json` NDJSON — the format the lane's
 * parser actually has to survive. A stub that just echoed argv would prove the first half and
 * quietly skip the second.
 *
 * Both stubs record their full argv to `<cwd>/args.txt` so a test can assert the seat (harness
 * binary, provider, model, thinking, tool flags) without depending on what the stub prints.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `claude -p` stand-in: argv → `args.txt`, and stdout is either the plain task text
 * (`--output-format text`) or a `{result, usage}` envelope (`--output-format json`). Honors the
 * same `FAIL` / `SLEEP1` / `SLEEPLONG` markers the lane tests use to drive failure and timing.
 */
export function writeClaudeLaneStub(dir: string, name = "claude-stub.sh"): string {
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/bash
printf '%s\\n' "$@" > "$PWD/args.txt"
# claude takes its prompt as the argument right after -p.
task=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-p" ]]; then task="$a"; break; fi
  prev="$a"
done
json=0
for a in "$@"; do if [[ "$a" == "json" ]]; then json=1; fi; done
case "$task" in *SLEEP1*) sleep 1 ;; *SLEEPLONG*) sleep 30 ;; esac
if [[ "$task" == *FAIL* ]]; then echo "boom" >&2; exit 3; fi
if [[ "$json" == 1 ]]; then
  printf '{"result":%s,"usage":{"output_tokens":41}}\\n' "$(printf 'REPORT:%s' "$task" | ${jsonEscape})"
else
  echo "REPORT:$task"
fi
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * A `pi -p --mode json` stand-in: argv → `args.txt`, and stdout is a real pi NDJSON stream —
 * `session`, `turn_start`, an assistant `message_end` carrying the answer as a content block, a
 * `turn_end` carrying `usage.output`, then `agent_end`. pi takes its prompt POSITIONALLY (last
 * argument), which is itself part of what these tests are checking.
 *
 * Markers, matched against the prompt: `FAIL` exits non-zero, `PIERROR` ends the assistant turn
 * with `stopReason:"error"` while still exiting 0 (pi's real behavior on a dead provider — the
 * case a lane that only checked the exit code would misread as success), `SLEEP1`/`SLEEPLONG`
 * stall.
 */
export function writePiLaneStub(dir: string, name = "pi-stub.sh"): string {
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/bash
printf '%s\\n' "$@" > "$PWD/args.txt"
# pi takes its prompt positionally: the last argument.
task="\${@: -1}"
case "$task" in *SLEEP1*) sleep 1 ;; *SLEEPLONG*) sleep 30 ;; esac
if [[ "$task" == *FAIL* ]]; then echo "boom" >&2; exit 3; fi
echo '{"type":"session","id":"11111111-2222-3333-4444-555555555555"}'
echo '{"type":"turn_start"}'
if [[ "$task" == *PIERROR* ]]; then
  echo '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"No API key found for anthropic.","content":[]}}'
else
  printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}]}}\\n' "$(printf 'REPORT:%s' "$task" | ${jsonEscape})"
fi
echo '{"type":"turn_end","message":{"usage":{"input":10,"output":41}}}'
echo '{"type":"agent_end"}'
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Shell that JSON-escapes stdin. The stubs embed model "answers" that are really the caller's own
 * prompt, and lane tests pass prompts with quotes and newlines in them; hand-rolled quoting there
 * produced NDJSON the parser rightly rejected.
 */
const jsonEscape = `python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))'`;

/**
 * The `[harness.lanes]` slice for a hand-built test Config. Defaults match the shipped schema;
 * pass overrides to pin a lane (`{ browser: { harness: "pi" } }`).
 */
export function laneConfig(
  overrides: Partial<Record<string, { harness?: "claude" | "pi"; provider?: string; model?: string }>> = {},
): Record<string, { harness: "claude" | "pi"; provider: string; model: string }> {
  const base: Record<string, "claude" | "pi"> = {
    quick: "pi",
    agent: "pi",
    browser: "claude",
    dream: "pi",
    dream_spike: "pi",
  };
  const out: Record<string, { harness: "claude" | "pi"; provider: string; model: string }> = {};
  for (const [lane, harness] of Object.entries(base)) {
    out[lane] = { harness, provider: "", model: "", ...(overrides[lane] ?? {}) };
  }
  return out;
}
