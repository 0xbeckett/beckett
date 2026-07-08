/** OpenRouter chat-completions provider used by `beckett eval` (OPS-105). */

export interface OpenRouterCompletionRequest {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface OpenRouterCompletionResult {
  id?: string;
  model?: string;
  output: string;
  usage?: unknown;
  raw: unknown;
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  appTitle?: string;
  referer?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenRouterProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly appTitle: string;
  private readonly referer: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenRouterProviderOptions = {}) {
    const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY ?? "";
    if (!key.trim()) {
      throw new Error("no OPENROUTER_API_KEY in env — OpenRouter evals are unavailable");
    }
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.appTitle = opts.appTitle ?? "Beckett eval";
    this.referer = opts.referer ?? "https://0xbeckett.me";
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: OpenRouterCompletionRequest): Promise<OpenRouterCompletionResult> {
    const model = req.model.trim();
    if (!model) throw new Error("OpenRouter model slug is required");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const messages = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.prompt },
      ];
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.referer,
          "X-Title": this.appTitle,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens,
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { rawText: text };
      }

      if (!res.ok) {
        const message =
          typeof json?.error?.message === "string"
            ? json.error.message
            : typeof json?.message === "string"
              ? json.message
              : text.slice(0, 500);
        throw new Error(`OpenRouter ${res.status} ${res.statusText}: ${message}`.trim());
      }

      const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
      const output = normalizeContent(choice?.message?.content ?? choice?.text);
      if (!output.trim()) throw new Error("OpenRouter response did not include model output");
      return { id: json?.id, model: json?.model, output, usage: json?.usage, raw: json };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`OpenRouter request timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
