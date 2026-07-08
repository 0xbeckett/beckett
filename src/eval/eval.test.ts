import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenRouterProvider } from "./openrouter.ts";
import { loadEvalSuite, renderEvalReport, runModelEval, selectPrompts, type EvalPrompt } from "./run.ts";

describe("eval prompt suite", () => {
  test("short suite spans UI, planning, backend, and debugging", async () => {
    const suite = await loadEvalSuite();
    const short = selectPrompts(suite, "short");
    expect(short.length).toBeGreaterThanOrEqual(4);
    const categories = new Set(short.map((p) => p.category));
    for (const required of ["ui", "planning", "backend", "debug"]) {
      expect(categories.has(required)).toBe(true);
    }
    expect(selectPrompts(suite, "full").length).toBeGreaterThan(short.length);
  });
});

describe("OpenRouter provider", () => {
  test("passes arbitrary model slugs through to OpenRouter with env API key", async () => {
    let captured: any;
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/api/v1",
      fetchImpl: (async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          id: "cmpl-test",
          model: "xai/grok-4-5",
          choices: [{ message: { content: "hello from model" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await provider.complete({ model: "xai/grok-4-5", prompt: "hi", maxTokens: 123 });
    expect(captured.model).toBe("xai/grok-4-5");
    expect(captured.max_tokens).toBe(123);
    expect(result.output).toBe("hello from model");
  });
});

describe("eval runner", () => {
  test("runs selected prompts, renders raw output, and saves markdown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "beckett-eval-test-"));
    const suitePath = join(tmp, "suite.json");
    const outputDir = join(tmp, "runs");
    mkdirSync(outputDir, { recursive: true });
    const suite: EvalPrompt[] = [
      { id: "ui", category: "ui", title: "UI", short: true, prompt: "Make a page" },
      { id: "debug", category: "debug", title: "Debug", short: false, prompt: "Fix a bug" },
    ];
    await Bun.write(suitePath, JSON.stringify(suite));
    const calls: string[] = [];
    const run = await runModelEval({
      model: "author/model",
      mode: "short",
      suitePath,
      outputDir,
      provider: {
        async complete(req) {
          calls.push(req.prompt);
          return { output: `RAW OUTPUT for ${req.model}`, raw: {} };
        },
      },
    });

    expect(calls).toEqual(["Make a page"]);
    expect(run.savePath).toBeTruthy();
    const rendered = renderEvalReport(run);
    expect(rendered).toContain("model: author/model");
    expect(rendered).toContain("### Raw model output");
    expect(rendered).toContain("RAW OUTPUT for author/model");
    expect(await Bun.file(run.savePath!).text()).toContain("RAW OUTPUT for author/model");
  });

  test("continueOnError records a prompt error and keeps the rest of the suite", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "beckett-eval-test-"));
    const suitePath = join(tmp, "suite.json");
    const suite: EvalPrompt[] = [
      { id: "first", category: "backend", title: "First", short: true, prompt: "one" },
      { id: "second", category: "debug", title: "Second", short: true, prompt: "two" },
    ];
    await Bun.write(suitePath, JSON.stringify(suite));
    const run = await runModelEval({
      model: "author/model",
      mode: "short",
      suitePath,
      continueOnError: true,
      provider: {
        async complete(req) {
          if (req.prompt === "one") throw new Error("provider exploded");
          return { output: "second output", raw: {} };
        },
      },
    });

    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[0]?.error).toBe("provider exploded");
    expect(run.prompts[1]?.output).toBe("second output");
    expect(renderEvalReport(run)).toContain("ERROR: provider exploded");
  });
});
