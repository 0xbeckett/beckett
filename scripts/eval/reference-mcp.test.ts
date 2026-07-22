import { expect, test } from "bun:test";
import { join } from "node:path";

test("reference benchmark MCP reports malformed JSON and continues serving", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "reference-mcp.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("{not-json}\n");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(responses[0]).toMatchObject({ id: null, error: { code: -32700 } });
  expect(responses[1]).toMatchObject({ id: 1, result: { serverInfo: { name: "eval-reference" } } });
  expect(responses[2]).toMatchObject({ id: 2, result: { tools: [{ name: "reference_lookup" }] } });
});
