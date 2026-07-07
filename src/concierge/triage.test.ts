import { describe, expect, test } from "bun:test";
import { createTriageClassifier, extractVerdictJson, parseVerdict } from "./triage.ts";

const VERDICT = '{"interject":true,"kind":"feature-wish","confidence":0.85,"reason":"concrete wish"}';

describe("parseVerdict", () => {
  test("parses a bare verdict object on stdout", () => {
    expect(parseVerdict(VERDICT).kind).toBe("feature-wish");
  });

  test("parses a clean verdict inside the claude --output-format json envelope", () => {
    const stdout = JSON.stringify({ type: "result", result: VERDICT });
    expect(parseVerdict(stdout).interject).toBe(true);
  });

  test("parses a fenced verdict inside the envelope (the prod fail-closed bug)", () => {
    const stdout = JSON.stringify({ type: "result", result: "```json\n" + VERDICT + "\n```" });
    const v = parseVerdict(stdout);
    expect(v.interject).toBe(true);
    expect(v.confidence).toBe(0.85);
  });

  test("parses a verdict wrapped in prose inside the envelope", () => {
    const stdout = JSON.stringify({ type: "result", result: `Here is my classification:\n${VERDICT}\nDone.` });
    expect(parseVerdict(stdout).kind).toBe("feature-wish");
  });

  test("still throws (fails closed upstream) on garbage", () => {
    expect(() => parseVerdict(JSON.stringify({ type: "result", result: "no json here" }))).toThrow();
  });
});

describe("extractVerdictJson", () => {
  test("strips ```json fences", () => {
    expect(extractVerdictJson("```json\n" + VERDICT + "\n```")).toBe(VERDICT);
  });

  test("strips bare ``` fences", () => {
    expect(extractVerdictJson("```\n" + VERDICT + "\n```")).toBe(VERDICT);
  });

  test("extracts the object from surrounding prose", () => {
    expect(extractVerdictJson(`sure!\n${VERDICT}\nhope that helps`)).toBe(VERDICT);
  });

  test("passes clean JSON through untouched", () => {
    expect(extractVerdictJson(VERDICT)).toBe(VERDICT);
  });
});

describe("cerebras provider", () => {
  const quietLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return quietLogger;
    },
  } as unknown as import("../types.ts").Logger;

  const burst = [{ authorDisplayName: "ro", content: "wish this exported csv", ts: 0 }];

  test("POSTs the prompt to the endpoint with the bearer key and parses the chat-completion verdict", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const triage = createTriageClassifier({
      provider: "cerebras",
      model: "gemma-4-31b",
      apiKey: "csk-test",
      logger: quietLogger,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"interject":true,"kind":"feature-wish","confidence":0.9,"reason":"csv wish"}' } }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const verdict = await triage(burst, []);
    expect(verdict).toMatchObject({ interject: true, kind: "feature-wish", confidence: 0.9 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer csk-test");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("gemma-4-31b");
    expect(body.messages[0].content).toContain("wish this exported csv");
  });

  test("fenced content still parses; HTTP errors and a missing key fail closed (interject=false)", async () => {
    const fenced = createTriageClassifier({
      provider: "cerebras",
      model: "gemma-4-31b",
      apiKey: "csk-test",
      logger: quietLogger,
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"interject":true,"kind":"social","confidence":0.8,"reason":"beat"}\n```' } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect((await fenced(burst, [])).kind).toBe("social");

    const httpErr = createTriageClassifier({
      provider: "cerebras",
      model: "gemma-4-31b",
      apiKey: "csk-test",
      logger: quietLogger,
      fetchFn: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    expect((await httpErr(burst, [])).interject).toBe(false);

    const saved = process.env.CEREBRAS_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    try {
      const noKey = createTriageClassifier({
        provider: "cerebras",
        model: "gemma-4-31b",
        logger: quietLogger,
        fetchFn: (async () => {
          throw new Error("must not be called without a key");
        }) as unknown as typeof fetch,
      });
      const verdict = await noKey(burst, []);
      expect(verdict.interject).toBe(false);
      expect(verdict.reason).toContain("CEREBRAS_API_KEY");
    } finally {
      if (saved !== undefined) process.env.CEREBRAS_API_KEY = saved;
    }
  });
});
