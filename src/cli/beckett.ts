#!/usr/bin/env bun
/**
 * Beckett v2 — the `beckett` CLI (`src/cli/beckett.ts`)
 * =======================================================================================
 * The small command surface the PARENT agent drives via Bash (Spec 05). Stateful commands
 * (worker control, discord reply, integrate, inject, status) forward to the shell over the
 * control bus (unix socket); memory commands run in-process over the markdown graph.
 *
 * Output is JSON on stdout (the parent reads it); errors go to stderr with a non-zero exit.
 * Install a PATH shim so the parent can call `beckett ...`:
 *   exec bun /home/beckett/beckett/src/cli/beckett.ts "$@"
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { callBus } from "../shell/control-bus.ts";
import { createMemory } from "../memory/index.ts";
import type { RememberIntent, NodeType } from "../types.ts";

const config = loadConfig();
const paths = buildPaths(config);
const SOCK = join(paths.beckettDir, "control.sock");

function out(data: unknown): never {
  process.stdout.write(typeof data === "string" ? data + "\n" : JSON.stringify(data, null, 2) + "\n");
  process.exit(0);
}
function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** Minimal flag parser: returns { _: positional[], flags: {k:v|true} }. */
function parse(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(t);
  }
  return { _, flags };
}

async function bus(cmd: string, args: Record<string, unknown>): Promise<never> {
  try {
    const res = await callBus(SOCK, cmd, args);
    if (!res.ok) fail(res.error ?? "command failed");
    out(res.data ?? { ok: true });
  } catch (err) {
    fail((err as Error).message);
  }
}

async function main(): Promise<void> {
  const [group, sub, ...rest] = process.argv.slice(2);

  // ── memory (in-process) ────────────────────────────────────────────────────────────────
  if (group === "memory") {
    const memory = createMemory({ memoryDir: paths.memoryDir, logger: undefined, git: sub === "remember" });
    if (sub === "recall") {
      const { _, flags } = parse(rest);
      const text = _.join(" ");
      if (!text) fail("usage: beckett memory recall \"<query>\" [--k N] [--hops N]");
      const r = await memory.recall({
        text,
        k: flags.k ? Number(flags.k) : undefined,
        hops: flags.hops ? Number(flags.hops) : undefined,
      });
      const lines: string[] = ["# index"];
      for (const il of r.index) lines.push(`- ${il.name}: ${il.description}`);
      lines.push("\n# hits");
      for (const h of r.hits) lines.push(`\n## ${h.node.name} (${h.node.type}, score ${h.score.toFixed(2)})\n${h.node.body}`);
      if (r.expanded.length) lines.push("\n# related (1-hop)\n" + r.expanded.map((e) => `- ${e.node.name}: ${e.node.description}`).join("\n"));
      if (r.phantoms.length) lines.push("\n# phantoms: " + r.phantoms.join(", "));
      if (r.notes.length) lines.push("\n# notes: " + r.notes.join("; "));
      out(lines.join("\n"));
    }
    if (sub === "remember") {
      const { flags } = parse(rest);
      const op = (flags.op as RememberIntent["op"]) ?? "create";
      const name = flags.name as string;
      if (!name) fail("usage: beckett memory remember --name <n> [--op create] [--type t] [--desc d] [--reason r] [--body <text>] [--link to:field,...]");
      let body = flags.body as string | undefined;
      if (flags["body-stdin"]) body = await Bun.stdin.text();
      const links = flags.link
        ? String(flags.link).split(",").map((s) => {
            const [to, field] = s.split(":");
            return { to: to!, field: field ?? "body" };
          })
        : undefined;
      const node = await memory.remember({
        op,
        name,
        type: flags.type ? (String(flags.type) as NodeType) : undefined,
        description: flags.desc ? String(flags.desc) : undefined,
        body,
        links,
        source: (flags.source as RememberIntent["source"]) ?? "conversation",
        reason: flags.reason ? String(flags.reason) : "remember via CLI",
      });
      out({ remembered: node.name, type: node.type });
    }
    fail(`unknown: beckett memory ${sub ?? ""}`);
  }

  // ── worker (control bus) ─────────────────────────────────────────────────────────────────
  if (group === "worker") {
    const { _, flags } = parse(rest);
    if (sub === "spawn") {
      if (!flags.task || !flags.repo) fail("usage: beckett worker spawn --task <t> --repo <path> --owned <g1,g2> --desc <d> [--system <s>] [--model <m>] [--base <ref>] [--turn-cap N] [--wall-s N] [--network] [--effort e]");
      await bus("worker.spawn", {
        task: String(flags.task),
        repoRoot: String(flags.repo),
        baseRef: flags.base ? String(flags.base) : undefined,
        systemAppend: flags.system ? String(flags.system) : undefined,
        model: flags.model ? String(flags.model) : undefined,
        scope: {
          ownedGlobs: flags.owned ? String(flags.owned).split(",") : ["**"],
          readGlobs: null,
          description: flags.desc ? String(flags.desc) : "",
        },
        envelope: {
          effort: flags.effort ? String(flags.effort) : undefined,
          turnCap: flags["turn-cap"] ? Number(flags["turn-cap"]) : undefined,
          wallClockS: flags["wall-s"] ? Number(flags["wall-s"]) : undefined,
          network: Boolean(flags.network),
        },
      });
    }
    if (sub === "status") await bus("worker.status", { workerId: _[0] });
    if (sub === "log") await bus("worker.log", { workerId: _[0], lastN: flags.last ? Number(flags.last) : undefined });
    if (sub === "nudge") await bus("worker.nudge", { workerId: _[0], text: _.slice(1).join(" ") });
    if (sub === "abort") await bus("worker.abort", { workerId: _[0], reason: flags.reason ? String(flags.reason) : undefined });
    if (sub === "checkin")
      await bus("worker.checkin", {
        workerId: _[0],
        afterTurns: flags["after-turns"] ? Number(flags["after-turns"]) : undefined,
        afterSecs: flags["after-secs"] ? Number(flags["after-secs"]) : undefined,
        reason: flags.reason ? String(flags.reason) : undefined,
      });
    fail(`unknown: beckett worker ${sub ?? ""}`);
  }

  // ── top-level (control bus) ──────────────────────────────────────────────────────────────
  if (group === "discord" && sub === "reply") {
    const { _, flags } = parse(rest);
    await bus("discord.reply", { channelId: flags.channel ? String(flags.channel) : undefined, text: _.join(" ") });
  }
  if (group === "inject") await bus("inject", { text: [sub, ...rest].filter(Boolean).join(" ") });
  if (group === "integrate") {
    const { _, flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    await bus("integrate", { workerIds: _, targetBranch: flags.target ? String(flags.target) : undefined });
  }
  if (group === "status") await bus("status", {});

  fail(`unknown command: beckett ${group ?? ""} ${sub ?? ""}\n` +
    "commands: inject | status | discord reply | worker spawn|status|log|nudge|abort|checkin | integrate | memory recall|remember");
}

main().catch((err) => fail((err as Error).message));
