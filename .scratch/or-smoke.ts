import { OpenRouterProvider } from "../src/eval/openrouter.ts";
const models = [
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-2.0-flash-001",
];
const p = new OpenRouterProvider();
for (const m of models) {
  try {
    const r = await p.complete({ model: m, prompt: "reply with exactly the word OK", maxTokens: 10, temperature: 0 });
    console.log("OK  " + m + " -> " + JSON.stringify(r.output.slice(0, 40)) + " resp=" + r.model);
  } catch (e) {
    console.log("ERR " + m + " -> " + (e as Error).message.slice(0, 140));
  }
}
