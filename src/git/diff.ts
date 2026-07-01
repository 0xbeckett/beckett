/**
 * Beckett — git numstat diff sizing (`src/git/diff.ts`)
 * =======================================================================================
 * THE `git diff --numstat` parser (issue #19 — previously hand-copied in all three drivers
 * and the supervision tailer). Ground-truth diff size for telemetry: unstaged + staged,
 * distinct files, binary files counted as files with zero line delta.
 */

/** Added/removed line counts + distinct changed files. */
export interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

/** Parse one `git diff --numstat` body into counts (binary rows use "-" for the numbers). */
export function parseNumstat(out: string, into: { added: number; removed: number; paths: Set<string> }): void {
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, r, ...rest] = parts;
    into.paths.add(rest.join("\t"));
    if (a !== "-") into.added += Number(a) || 0;
    if (r !== "-") into.removed += Number(r) || 0;
  }
}

/**
 * Synchronous working-tree diff size for `workspace` (unstaged + staged). Best-effort by
 * contract: a git failure yields zeros, never a throw — telemetry must not disturb workers.
 */
export function diffStatSync(workspace: string | undefined | null): DiffStat {
  if (!workspace) return { added: 0, removed: 0, files: 0 };
  const acc = { added: 0, removed: 0, paths: new Set<string>() };
  for (const staged of [false, true]) {
    const cmd = ["git", "-C", workspace, "diff", "--numstat"];
    if (staged) cmd.push("--staged");
    try {
      const r = Bun.spawnSync(cmd);
      if (r.success) parseNumstat(r.stdout.toString(), acc);
    } catch {
      /* best-effort */
    }
  }
  return { added: acc.added, removed: acc.removed, files: acc.paths.size };
}
