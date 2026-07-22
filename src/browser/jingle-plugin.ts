#!/usr/bin/env bun
/**
 * agent-browser credential-provider plugin backed by the jingle vault
 * (https://github.com/frgmt0/jingle-jingle).
 *
 * Speaks `agent-browser.plugin.v1`: one JSON request on stdin, one JSON response on stdout.
 * `beckett browser` registers it via AGENT_BROWSER_PLUGINS, so
 *
 *   beckett browser auth login <entry> --credential-provider jingle --item <entry>
 *
 * resolves the username/password from jingle at login time. Secret values flow
 * jingle → this process → agent-browser's form fill; they never enter a model transcript,
 * argv, or a log line, and every access lands in jingle's hash-chained audit log.
 * Locked entries are refused (unlock deliberately stays a human step).
 */

interface PluginRequest {
  protocol?: string;
  type?: string;
  capability?: string;
  request?: { profileName?: string; itemRef?: string; url?: string };
}

const PROTOCOL = "agent-browser.plugin.v1";
/** Entry names come from our own CLI surface; refuse anything shell-metacharacter-shaped. */
const ENTRY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,127}$/;

function respond(payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, ...payload }) + "\n");
  process.exit(0);
}

function fail(error: string): never {
  respond({ success: false, error });
}

async function jingle(args: string[], stdin: "ignore" | "inherit" = "ignore"): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd: ["jingle", ...args], stdin, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text().catch(() => ""),
    new Response(child.stderr as ReadableStream).text().catch(() => ""),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Read one secret field via `jingle exec` env injection; the value exists only in memory here. */
async function readSecretField(entry: string, field: string): Promise<string> {
  const result = await jingle([
    "exec",
    "-s",
    `${entry}:${field}=JINGLE_PLUGIN_VALUE`,
    "--",
    "sh",
    "-c",
    'printf %s "$JINGLE_PLUGIN_VALUE"',
  ]);
  if (result.code !== 0) {
    throw new Error(`jingle exec failed for field "${field}": ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

async function resolveCredential(request: PluginRequest["request"]): Promise<never> {
  const entry = (request?.itemRef ?? request?.profileName ?? "").trim();
  if (!entry) fail("credential.resolve needs an --item naming the jingle entry");
  if (!ENTRY_NAME.test(entry)) fail(`invalid jingle entry name: ${JSON.stringify(entry)}`);

  const shown = await jingle(["show", entry, "--json"]);
  if (shown.code !== 0) fail(`jingle entry "${entry}" is unavailable: ${shown.stderr.trim() || `exit ${shown.code}`}`);
  let meta: { username?: string | null; url?: string | null; service?: string | null; secret_fields?: string[]; locked?: boolean };
  try {
    meta = JSON.parse(shown.stdout);
  } catch {
    fail(`jingle show returned unparseable metadata for "${entry}"`);
  }
  if (meta.locked) fail(`jingle entry "${entry}" is locked - a human must run: jingle unlock ${entry}`);
  const fields = meta.secret_fields ?? [];
  if (!fields.includes("password")) fail(`jingle entry "${entry}" has no "password" secret field (fields: ${fields.join(", ") || "none"})`);

  let username = (meta.username ?? "").trim();
  if (!username || username === "-") {
    const usernameField = ["username", "email", "login"].find((field) => fields.includes(field));
    if (usernameField) username = await readSecretField(entry, usernameField);
  }
  if (!username) fail(`jingle entry "${entry}" has no username metadata and no username/email/login secret field`);
  const password = await readSecretField(entry, "password");

  const url = (meta.url ?? "").trim() || (meta.service ? `https://${meta.service}` : undefined);
  respond({
    success: true,
    credential: { username, password, ...(url ? { url } : {}) },
  });
}

async function main(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  let request: PluginRequest;
  try {
    request = JSON.parse(raw);
  } catch {
    fail("request was not valid JSON");
  }
  if (request.protocol !== PROTOCOL) fail(`unsupported protocol: ${String(request.protocol)}`);
  if (request.type === "plugin.manifest") {
    respond({
      success: true,
      manifest: {
        name: "jingle",
        capabilities: ["credential.read"],
        description: "Resolve login credentials from Beckett's jingle vault (never prints secrets)",
      },
    });
  }
  if (request.type === "credential.resolve") {
    await resolveCredential(request.request);
  }
  fail(`unsupported request type: ${String(request.type)}`);
}

main().catch((error) => fail(String((error as Error).message ?? error)));
