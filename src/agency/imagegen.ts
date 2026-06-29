/**
 * Image generation (`src/agency/imagegen.ts`)
 * =======================================================================================
 * A cohesive wrapper around the Codex CLI's built-in `image_gen` tool, so Beckett has ONE
 * deterministic way to make an image instead of improvising (in the past it scaffolded a
 * whole `~/projects/imagegen` project instead of just calling Codex).
 *
 * Beckett's Codex is authed via `~/.codex/auth.json` (ChatGPT OAuth) and has the
 * `image_generation` (default) + `imagegenext` features enabled in `~/.codex/config.toml`.
 * We invoke `codex exec` with a tight, scaffold-proof instruction and — the key bit — we
 * VERIFY the file landed at the exact path we asked for, relocating it from Codex's default
 * `generated_images/` dir if it saved there instead. The caller always gets back the one
 * absolute path it asked for, or a hard error. No half-success, no stray projects.
 */

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "../types.ts";

export class ImageGenError extends Error {}

/** Sizes the underlying image tool accepts. `auto` lets the model pick. */
const ALLOWED_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);
const DEFAULT_SIZE = "1024x1024";
const IMAGE_EXTS = new Set([".png", ".webp", ".jpg", ".jpeg"]);

export interface ImageGenOptions {
  prompt: string;
  /** Absolute or relative file path to save to. Default: <imagesDir>/<ts>-<slug>.png */
  out?: string;
  /** One of ALLOWED_SIZES. Default 1024x1024. */
  size?: string;
  /** Reference image paths to edit / build on (turns this into an edit). */
  refs?: string[];
  /** Ask for a transparent (alpha) background — uses Codex's built-in chroma-key flow. */
  transparent?: boolean;
  /** Optional Codex model override (the driver model, not the image model). */
  model?: string;
  /** Hard timeout. Default 5 min — generation is one Codex turn, usually <60s. */
  timeoutMs?: number;
}

export interface ImageGenResult {
  path: string;
  bytes: number;
  size: string;
  prompt: string;
  edited: boolean;
  /** True if we had to move the artifact from Codex's default dir to `path`. */
  relocated: boolean;
}

export interface ImageGenDeps {
  /** Where unnamed images go: <beckettDir>/images. */
  imagesDir: string;
  logger: Logger;
  /** Override the codex binary (env BECKETT_CODEX_BIN, else auto-resolved). */
  codexBin?: string;
  /** CODEX_HOME (default ~/.codex) — used to find images Codex saved to its default dir. */
  codexHome?: string;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  );
}

/** Resolve the codex launcher: explicit override → ~/.local/bin → ~/.bun/bin → PATH. */
function resolveCodexBin(home: string, override?: string): string {
  if (override) return override;
  if (process.env.BECKETT_CODEX_BIN) return process.env.BECKETT_CODEX_BIN;
  for (const c of [join(home, ".local/bin/codex"), join(home, ".bun/bin/codex")]) {
    if (existsSync(c)) return c;
  }
  return "codex"; // fall back to PATH
}

export class CodexImageGen {
  private readonly home = homedir();
  private readonly imagesDir: string;
  private readonly logger: Logger;
  private readonly codexBin: string;
  private readonly codexHome: string;

  constructor(deps: ImageGenDeps) {
    this.imagesDir = deps.imagesDir;
    this.logger = deps.logger;
    this.codexBin = resolveCodexBin(this.home, deps.codexBin);
    this.codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(this.home, ".codex");
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    const prompt = opts.prompt?.trim();
    if (!prompt) throw new ImageGenError("empty prompt");

    const size = opts.size ?? DEFAULT_SIZE;
    if (!ALLOWED_SIZES.has(size)) {
      throw new ImageGenError(`bad --size "${size}"; allowed: ${[...ALLOWED_SIZES].join(", ")}`);
    }

    // Reference images (edit mode) — must exist.
    const refs = (opts.refs ?? []).map((r) => resolve(r));
    for (const r of refs) if (!existsSync(r)) throw new ImageGenError(`reference image not found: ${r}`);
    const edited = refs.length > 0;

    // Resolve the destination path.
    const outPath = opts.out
      ? isAbsolute(opts.out)
        ? opts.out
        : resolve(opts.out)
      : join(this.imagesDir, `${Date.now()}-${slugify(prompt)}.png`);
    const outDir = dirname(outPath);
    mkdirSync(outDir, { recursive: true });

    const instruction = this.buildInstruction({ prompt, size, outPath, transparent: !!opts.transparent, edited });

    // Args: bypass sandbox/approvals so it can write the file unattended; suppress the
    // under-development imagegenext warning so stdout stays clean.
    const args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "suppress_unstable_features_warning=true",
    ];
    if (opts.model) args.push("-m", opts.model);
    for (const r of refs) args.push("-i", r);
    args.push(instruction);

    const startedAt = Date.now() - 2000; // small skew cushion for mtime comparisons

    this.logger.info("image gen start", { outPath, size, refs: refs.length, edited });
    const { code, stdout, stderr } = await this.runCodex(args, outDir, opts.timeoutMs ?? 300_000);

    // Find the artifact. Prefer the exact path we asked for; otherwise locate the freshest
    // image Codex produced and relocate it. This is what makes the wrapper deterministic.
    let relocated = false;
    if (!existsSync(outPath)) {
      const found = this.findFreshImage(startedAt, [outDir, join(outDir, "tmp/imagegen"), join(this.codexHome, "generated_images")]);
      if (!found) {
        const tail = (stderr || stdout || "").trim().split("\n").slice(-12).join("\n");
        throw new ImageGenError(
          `codex produced no image (exit ${code}). No file at ${outPath} and none found in the default dirs.\n${tail}`,
        );
      }
      copyFileSync(found, outPath);
      relocated = true;
      this.logger.info("image relocated to requested path", { from: found, to: outPath });
    }

    const bytes = statSync(outPath).size;
    if (bytes === 0) {
      rmSync(outPath, { force: true });
      throw new ImageGenError(`codex wrote an empty file at ${outPath} (exit ${code})`);
    }
    return { path: outPath, bytes, size, prompt, edited, relocated };
  }

  private buildInstruction(p: {
    prompt: string;
    size: string;
    outPath: string;
    transparent: boolean;
    edited: boolean;
  }): string {
    const lines = [
      "You have a built-in `image_gen` tool. Your ONLY task is to produce exactly ONE image",
      "and save it to a specific file. Obey strictly:",
      "- Use the `image_gen` tool. Do NOT write code, do NOT use python/PIL/SVG/HTML/CSS, do NOT",
      "  create any project, directory, or extra files, and do NOT install anything.",
      p.edited
        ? "- Edit/build on the reference image(s) attached to this message to match the description."
        : "- Generate a brand-new image matching the description.",
      "",
      "Description:",
      p.prompt,
      "",
      `Requested dimensions: ${p.size}.`,
    ];
    if (p.transparent) {
      lines.push(
        "Transparent background: produce a PNG with a real transparent alpha channel using your",
        "built-in transparent-image (chroma-key) workflow.",
      );
    }
    lines.push(
      "",
      `Save the final image to EXACTLY this absolute path (no copies anywhere else):`,
      p.outPath,
      "",
      "After saving, reply with only that path. No summary, no commentary, no follow-up questions.",
    );
    return lines.join("\n");
  }

  /** Newest image file (by mtime) at or under the given dirs, modified since `sinceMs`. */
  private findFreshImage(sinceMs: number, dirs: string[]): string | undefined {
    let best: { path: string; mtime: number } | undefined;
    const consider = (path: string) => {
      const dot = path.lastIndexOf(".");
      if (dot < 0 || !IMAGE_EXTS.has(path.slice(dot).toLowerCase())) return;
      let st;
      try {
        st = statSync(path);
      } catch {
        return;
      }
      if (!st.isFile() || st.mtimeMs < sinceMs) return;
      if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs };
    };
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isFile()) consider(full);
        else if (e.isDirectory()) {
          // one level deep: Codex nests under generated_images/<id>/...
          try {
            for (const e2 of readdirSync(full, { withFileTypes: true })) {
              if (e2.isFile()) consider(join(full, e2.name));
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    return best?.path;
  }

  private async runCodex(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    // Inherit env but guarantee the toolchain dirs are on PATH and force ChatGPT auth
    // (drop OPENAI_API_KEY so Codex uses auth.json rather than API-key mode).
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.OPENAI_API_KEY;
    const extraPath = [join(this.home, ".local/bin"), join(this.home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extraPath}:${env.PATH}` : extraPath;
    env.CODEX_HOME = this.codexHome;

    const proc = Bun.spawn([this.codexBin, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    if (timedOut) throw new ImageGenError(`codex image gen timed out after ${Math.round(timeoutMs / 1000)}s`);
    return { code, stdout, stderr };
  }
}
