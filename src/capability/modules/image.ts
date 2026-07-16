/**
 * Beckett v5 — the image capability module (`src/capability/modules/image.ts`)
 * =======================================================================================
 * The `beckett image …` surface (in-process generation via `agency/imagegen.ts` — Codex by
 * default, `--model fal-ai/...` routes to the fal.ai queue), normalized onto the common
 * factory shape (V5 Phase 2). The handler body is the former `cli/beckett.ts::runImage`
 * moved verbatim; the CLI characterization suite pins its observable behavior byte-for-byte.
 */

import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { CodexImageGen } from "../../agency/imagegen.ts";
import { fail, out, parse } from "../../cli/io.ts";

export function createImageCapability({ paths, logger }: CapabilityDeps): Capability {
  async function runImage(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const video = sub === "video";
    const { _, flags } = parse((video ? rest : [sub, ...rest]).filter(Boolean) as string[]);
    const prompt = _.join(" ").trim();
    if (!prompt)
      fail(
        'usage: beckett image [video] "<prompt>" [--out <path>] [--size 1024x1024|1536x1024|1024x1536|auto] [--ref <file[,file]>] [--transparent] [--model <codex-model|fal-ai/...>]',
      );
    if (video && !String(flags.model ?? "").startsWith("fal-ai/")) {
      fail('beckett image video requires a fal video model, e.g. --model "fal-ai/bytedance/seedance/..."');
    }
    const refs = flags.ref ? String(flags.ref).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const gen = new CodexImageGen({ imagesDir: paths.imagesDir, logger });
    out(
      await gen.generate({
        prompt,
        out: flags.out ? String(flags.out) : undefined,
        size: flags.size ? String(flags.size) : undefined,
        refs,
        transparent: flags.transparent === true || flags.transparent === "true",
        model: flags.model ? String(flags.model) : undefined,
        media: video ? "video" : undefined,
      }),
    );
  }

  return {
    id: "image",
    summary: "in-process image/video generation (Codex by default; fal-ai/... routes to fal)",
    actionClass: ActionClass.FREE,
    cliHelp: "image",
    cliVerbs: [
      {
        name: "image",
        summary: "generate or edit a raster image (or a fal video)",
        usage:
          'beckett image [video] "<prompt>" [--out <path>] [--size 1024x1024|1536x1024|1024x1536|auto] [--ref <file[,file]>] [--transparent] [--model <codex-model|fal-ai/...>]',
        run: runImage,
      },
    ],
    busCommands: [],
    skillDoc: ".claude/skills/image/SKILL.md",
  };
}
