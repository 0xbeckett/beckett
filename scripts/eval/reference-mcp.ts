#!/usr/bin/env bun

import { createInterface } from "node:readline";

const tool = {
  name: "reference_lookup",
  description: "Look up a named static benchmark reference. This cannot inspect or interact with web pages.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let request: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(line) as typeof request;
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }) + "\n");
    continue;
  }
  if (request.id === undefined) continue;
  let result: unknown;
  if (request.method === "initialize") {
    result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "eval-reference", version: "1" } };
  } else if (request.method === "tools/list") {
    result = { tools: [tool] };
  } else if (request.method === "tools/call" && request.params?.name === tool.name) {
    const args = request.params.arguments as { name?: unknown } | undefined;
    const value = args?.name === "browser-routing-control" ? "STATIC-ROUTE-7392" : "not-found";
    result = { content: [{ type: "text", text: JSON.stringify({ value }) }], isError: false };
  } else if (request.method === "ping") {
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n");
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
