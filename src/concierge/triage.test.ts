import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTriagePrompt, createTriageClassifier, extractVerdictJson, parseVerdict } from "./triage.ts";

const VERDICT = '{"interject":true,"kind":"feature-wish","confidence":0.85,"reason":"concrete wish"}';

describe("parseVerdict", () => {
  test("parses a bare verdict object on stdout", () => {
    expect(parseVerdict(VERDICT).kind).toBe("feature-wish");
  });

  test("defaults addressee to unclear when the model omits it (no fail-closed on the whole verdict)", () => {
    // A verdict without the OPS-101 addressee field must still parse — an omission is a soft
    // downrank ("unclear"), never total silence that would ghost a beat gemma DID want to land.
    expect(parseVerdict(VERDICT).addressee).toBe("unclear");
  });

  test("carries the addressee read through when present", () => {
    const withAddr = '{"interject":false,"kind":"none","confidence":0.2,"reason":"aimed at ro","addressee":"other"}';
    expect(parseVerdict(withAddr).addressee).toBe("other");
  });

  test("accepts the OPS-116 beckett-thread addressee read (continuation of a Beckett thread)", () => {
    // The new granular read: a continuation still pointed Beckett's way is distinct from a fresh
    // direct address AND from an `other` pivot. It must round-trip so the frame can lean on it.
    const cont = '{"interject":true,"kind":"social","confidence":0.7,"reason":"they answered me","addressee":"beckett-thread"}';
    expect(parseVerdict(cont).addressee).toBe("beckett-thread");
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

describe("buildTriagePrompt", () => {
  const staticPrompt = "SCORER PROMPT";
  const transcript = [
    { authorDisplayName: "ro", content: "hey ssh", ts: 0 },
    { authorDisplayName: "ssh", content: "yo", ts: 1 },
  ];
  const burst = [{ authorDisplayName: "ro", content: "ssh, can you check the deploy?", ts: 2 }];

  test("names the participants and the speaker of the latest message", () => {
    const prompt = buildTriagePrompt(staticPrompt, burst, transcript);
    expect(prompt).toContain("People talking in this channel");
    expect(prompt).toContain("ro, ssh");
    expect(prompt).toContain("Speaker of the latest message to classify: ro");
    expect(prompt).toContain("Beckett is NOT one of them");
  });

  test("still renders the burst and transcript content", () => {
    const prompt = buildTriagePrompt(staticPrompt, burst, transcript);
    expect(prompt).toContain("ssh, can you check the deploy?");
    expect(prompt).toContain("hey ssh");
  });
});

describe("OPS-116 addressee granularity — real-transcript regression cases", () => {
  // The static rubric is what teaches the fast scorer to tell the four addressee reads apart. We
  // can't run Haiku deterministically in a unit test, so these pin the two things we CAN pin: the
  // rubric carries the sharpened logic, and the runtime prompt renders the real failing transcript
  // with the participants/speaker context the model needs to detect the pivot.
  const rubric = readFileSync(join(import.meta.dir, "triage.md"), "utf8");

  test("the rubric distinguishes all four substantive addressee reads", () => {
    expect(rubric).toContain("**beckett**");
    expect(rubric).toContain("**beckett-thread**");
    expect(rubric).toContain("**other**");
    expect(rubric).toContain("**group**");
    // The output contract must advertise the new enum member so the model can emit it.
    expect(rubric).toContain('"addressee":"beckett|beckett-thread|other|group|unclear"');
  });

  test("the rubric teaches the named-party rule and pivot detection (the two OPS-116 failures)", () => {
    expect(rubric).toMatch(/@mentions or names a DIFFERENT person/i);
    expect(rubric).toMatch(/PIVOT/);
    // The concrete real-transcript example — Beckett waved off mid-thread — is present as few-shot.
    expect(rubric).toContain("why are you responding, that wasn't directed to you");
  });

  test("a Beckett thread that has pivoted to another named party renders with the pivot context", () => {
    // Real shape of the failure: Beckett was in the thread, then ssh's newest line pivots to ro.
    // The classifier must see WHO spoke last and who is named — buildTriagePrompt supplies both.
    const transcript = [
      { authorDisplayName: "ro", content: "how would we even ship that?", ts: 0 },
      { authorDisplayName: "Beckett", content: "i can spin it up as a ticket", ts: 1 },
      { authorDisplayName: "ssh", content: "hm", ts: 2 },
    ];
    const burst = [{ authorDisplayName: "ssh", content: "ro, what do you actually want it to do?", ts: 3 }];
    const prompt = buildTriagePrompt(rubric, burst, transcript);

    expect(prompt).toContain("Speaker of the latest message to classify: ssh");
    expect(prompt).toContain("ro, what do you actually want it to do?");
    // Beckett is named in the transcript but must never appear as a "participant" to address.
    expect(prompt).toContain("Beckett is NOT one of them");
  });

  test("a message naming another user renders that user as the addressed party", () => {
    const burst = [{ authorDisplayName: "ro", content: "@ssh what's the staging port?", ts: 1 }];
    const prompt = buildTriagePrompt(rubric, burst, []);
    expect(prompt).toContain("Speaker of the latest message to classify: ro");
    expect(prompt).toContain("@ssh what's the staging port?");
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
