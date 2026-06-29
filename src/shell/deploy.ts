/**
 * Beckett — tunnel deploy (`src/shell/deploy.ts`)
 * =======================================================================================
 * Publishes a locally-running app to `<name>.0xbeckett.me` through a Cloudflare **named
 * tunnel** (cloudflared) that Beckett runs on the host. This powers the proactive
 * "saw yall yapping — threw it up here" flow: spin a mockup on a local port, give it a real
 * URL, announce it. It is reversible/FREE (a record + an ingress rule you can delete) — but
 * it IS an outward action, so the URL is announced in voice (see the `deploy` skill).
 *
 * Two moving parts, NO account-level credentials:
 *   1. The cloudflared ingress file `~/.cloudflared/config.yml` — a file Beckett owns. We
 *      read/modify/write it to map `hostname → service` (e.g. `http://localhost:3000`),
 *      always keeping the `http_status:404` catch-all LAST. cloudflared has no YAML dep here,
 *      so we hand-render the known, fixed shape (round-trip safe; top-level extra keys and
 *      per-rule fields are preserved verbatim).
 *   2. A proxied CNAME `<name>.0xbeckett.me → <tunnelId>.cfargotunnel.com` via the zone-scoped
 *      {@link CfDns} token. That's the only credentialed step.
 *
 * The tunnel itself is a ONE-TIME human prereq (`cloudflared tunnel login && cloudflared
 * tunnel create beckett`, then `CLOUDFLARE_TUNNEL_ID=<id>` in `~/.beckett/.env`). Until that
 * id is present we refuse with a clear message rather than half-deploying.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CfDns } from "../agency/cloudflare.ts";
import type { Logger } from "../types.ts";

/** One cloudflared ingress rule. The catch-all has no `hostname`. Unknown fields round-trip. */
export interface IngressRule {
  hostname?: string;
  service: string;
  /** Any extra YAML lines under this rule (e.g. `originRequest:`), preserved verbatim. */
  extraLines?: string[];
}

/** The parsed cloudflared config we care about. `extraTop` preserves unknown top-level lines. */
export interface TunnelConfig {
  tunnel?: string;
  credentialsFile?: string;
  ingress: IngressRule[];
  /** Unknown top-level `key: value` lines, preserved verbatim and re-emitted first. */
  extraTop: string[];
}

/** Thrown when a deploy is attempted with no tunnel configured (the one-time human prereq). */
export class TunnelNotConfiguredError extends Error {
  constructor() {
    super(
      "deploy: CLOUDFLARE_TUNNEL_ID is not set in ~/.beckett/.env — the named tunnel is a " +
        "one-time human setup. Run on the host:\n" +
        "  cloudflared tunnel login\n" +
        "  cloudflared tunnel create beckett\n" +
        "then add CLOUDFLARE_TUNNEL_ID=<the-new-tunnel-id> to ~/.beckett/.env.",
    );
    this.name = "TunnelNotConfiguredError";
  }
}

const CATCH_ALL_SERVICE = "http_status:404";

/** Resolve `~` to the home dir (the cloudflared config path uses it by convention). */
function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Parse a cloudflared `config.yml` of the known shape into a {@link TunnelConfig}. Tolerant and
 * round-trip oriented: top-level scalars `tunnel`/`credentials-file` are recognized, other
 * top-level lines are preserved in `extraTop`, and each ingress list item keeps any extra
 * indented lines beyond `hostname`/`service`. Not a general YAML parser — by design, since
 * Beckett owns this file.
 */
export function parseTunnelConfig(text: string): TunnelConfig {
  const cfg: TunnelConfig = { ingress: [], extraTop: [] };
  const lines = text.split(/\r?\n/);
  let inIngress = false;
  let current: IngressRule | null = null;
  const pushCurrent = () => {
    if (current) cfg.ingress.push(current);
    current = null;
  };

  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      // A new top-level key ends the ingress block.
      pushCurrent();
      inIngress = false;
      const line = raw.trim();
      if (line === "ingress:") {
        inIngress = true;
        continue;
      }
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) {
        const key = m[1]!;
        const val = stripQuotes(m[2]!.trim());
        if (key === "tunnel") cfg.tunnel = val;
        else if (key === "credentials-file") cfg.credentialsFile = val;
        else cfg.extraTop.push(raw.trimEnd());
      } else {
        cfg.extraTop.push(raw.trimEnd());
      }
      continue;
    }

    if (!inIngress) continue; // indented line outside ingress → ignore (owned file)

    const body = raw.trim();
    if (body.startsWith("- ")) {
      // Start of a new ingress rule item.
      pushCurrent();
      current = { service: "" };
      const first = body.slice(2).trim();
      applyRuleField(current, first);
    } else if (current) {
      applyRuleField(current, body);
    }
  }
  pushCurrent();
  return cfg;
}

/** Apply a `key: value` (or extra) line onto an ingress rule, preserving unknowns. */
function applyRuleField(rule: IngressRule, line: string): void {
  const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (m && (m[1] === "hostname" || m[1] === "service")) {
    const val = stripQuotes(m[2]!.trim());
    if (m[1] === "hostname") rule.hostname = val;
    else rule.service = val;
    return;
  }
  (rule.extraLines ??= []).push(line);
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Render a {@link TunnelConfig} back to YAML text in the canonical cloudflared shape:
 * `tunnel` + `credentials-file` first, preserved extra top-level lines, then the `ingress:`
 * list with the `http_status:404` catch-all guaranteed LAST.
 */
export function renderTunnelConfig(cfg: TunnelConfig): string {
  const out: string[] = [];
  if (cfg.tunnel) out.push(`tunnel: ${cfg.tunnel}`);
  if (cfg.credentialsFile) out.push(`credentials-file: ${cfg.credentialsFile}`);
  for (const extra of cfg.extraTop) out.push(extra);

  out.push("ingress:");
  for (const rule of orderedIngress(cfg.ingress)) {
    if (rule.hostname !== undefined) {
      out.push(`  - hostname: ${rule.hostname}`);
      out.push(`    service: ${rule.service}`);
    } else {
      out.push(`  - service: ${rule.service}`);
    }
    for (const extra of rule.extraLines ?? []) out.push(`    ${extra}`);
  }
  return out.join("\n") + "\n";
}

/** Return ingress rules with the catch-all (no hostname / http_status:404) moved to the end. */
function orderedIngress(ingress: IngressRule[]): IngressRule[] {
  const isCatchAll = (r: IngressRule) => r.hostname === undefined || r.service.startsWith("http_status:");
  const rules = ingress.filter((r) => !isCatchAll(r));
  const catchAll = ingress.find(isCatchAll) ?? { service: CATCH_ALL_SERVICE };
  return [...rules, catchAll];
}

export interface TunnelDeployerOptions {
  /** The cloudflared named-tunnel id (env CLOUDFLARE_TUNNEL_ID); empty/undefined → not configured. */
  tunnelId?: string;
  /** The zone-scoped DNS client (for the CNAME step). */
  dns: CfDns;
  logger: Logger;
  /** Override the config.yml path (tests). Defaults to ~/.cloudflared/config.yml. */
  configPath?: string;
  /** Override the apex domain. Defaults to the dns client's zone name. */
  zone?: string;
  /** Run a shell command (the cloudflared reload). Overridable for tests. */
  runCommand?: (cmd: string[]) => Promise<{ code: number; stderr: string }>;
}

/**
 * Deploys/undeploys hostnames on Beckett's named tunnel. Owns the ingress file edit + the CNAME;
 * never touches account-level cloudflared state. `deploy()` is idempotent (re-running replaces the
 * rule + upserts the CNAME).
 */
export class TunnelDeployer {
  private readonly tunnelId?: string;
  private readonly dns: CfDns;
  private readonly logger: Logger;
  private readonly configPath: string;
  private readonly zoneOverride?: string;
  private readonly runCommand: (cmd: string[]) => Promise<{ code: number; stderr: string }>;

  constructor(opts: TunnelDeployerOptions) {
    this.tunnelId = opts.tunnelId && opts.tunnelId.length > 0 ? opts.tunnelId : undefined;
    this.dns = opts.dns;
    this.logger = opts.logger;
    this.configPath = opts.configPath ?? join(homedir(), ".cloudflared", "config.yml");
    this.zoneOverride = opts.zone;
    this.runCommand = opts.runCommand ?? defaultRunCommand;
  }

  /** Whether the named tunnel is configured (the one-time prereq is done). */
  get available(): boolean {
    return this.tunnelId !== undefined;
  }

  private requireTunnel(): string {
    if (!this.tunnelId) throw new TunnelNotConfiguredError();
    return this.tunnelId;
  }

  /** Read + parse the ingress config, creating a sane default if the file is absent. */
  private loadConfig(tunnelId: string): TunnelConfig {
    if (existsSync(this.configPath)) {
      return parseTunnelConfig(readFileSync(this.configPath, "utf8"));
    }
    return {
      tunnel: tunnelId,
      credentialsFile: join(dirname(this.configPath), `${tunnelId}.json`),
      ingress: [{ service: CATCH_ALL_SERVICE }],
      extraTop: [],
    };
  }

  /** Write the config back, ensuring the parent dir exists. */
  private saveConfig(cfg: TunnelConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, renderTunnelConfig(cfg), "utf8");
  }

  private async hostnameFor(name: string): Promise<string> {
    if (name.includes(".")) return name.replace(/\.$/, "");
    const zone = this.zoneOverride ?? (await this.dns.zoneName());
    return `${name}.${zone}`;
  }

  /**
   * Publish `<name>` (a label or full hostname) to a local `service` (e.g. `http://localhost:3000`).
   * Inserts/replaces the ingress rule (catch-all stays last), writes the config, upserts the
   * proxied CNAME to `<tunnelId>.cfargotunnel.com`, then reloads cloudflared. Returns the live URL.
   */
  async deploy(p: { name: string; service: string }): Promise<{
    url: string;
    hostname: string;
    service: string;
    tunnelId: string;
    reload: { reloaded: boolean; hint?: string };
  }> {
    const tunnelId = this.requireTunnel();
    const hostname = await this.hostnameFor(p.name);

    const cfg = this.loadConfig(tunnelId);
    if (!cfg.tunnel) cfg.tunnel = tunnelId;
    const existing = cfg.ingress.find((r) => r.hostname === hostname);
    if (existing) existing.service = p.service;
    else cfg.ingress.push({ hostname, service: p.service });
    this.saveConfig(cfg);

    await this.dns.upsert({
      name: hostname,
      type: "CNAME",
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    });

    const reload = await this.reload();
    this.logger.info("deployed", { hostname, service: p.service });
    return { url: `https://${hostname}`, hostname, service: p.service, tunnelId, reload };
  }

  /** List the published hostnames (ingress rules with a hostname → service). */
  list(): Array<{ hostname: string; service: string }> {
    if (!this.available) throw new TunnelNotConfiguredError();
    if (!existsSync(this.configPath)) return [];
    const cfg = parseTunnelConfig(readFileSync(this.configPath, "utf8"));
    return cfg.ingress
      .filter((r) => r.hostname !== undefined)
      .map((r) => ({ hostname: r.hostname!, service: r.service }));
  }

  /**
   * Remove a hostname: drop its ingress rule + delete the CNAME. Idempotent — a missing rule or
   * record is not an error. Reloads cloudflared after the edit.
   */
  async remove(name: string): Promise<{
    hostname: string;
    removedRule: boolean;
    deletedRecords: number;
    reload: { reloaded: boolean; hint?: string };
  }> {
    const tunnelId = this.requireTunnel();
    const hostname = await this.hostnameFor(name);

    let removedRule = false;
    if (existsSync(this.configPath)) {
      const cfg = parseTunnelConfig(readFileSync(this.configPath, "utf8"));
      const before = cfg.ingress.length;
      cfg.ingress = cfg.ingress.filter((r) => r.hostname !== hostname);
      removedRule = cfg.ingress.length < before;
      if (removedRule) {
        if (!cfg.tunnel) cfg.tunnel = tunnelId;
        this.saveConfig(cfg);
      }
    }
    const { deleted } = await this.dns.remove(hostname, "CNAME");
    const reload = removedRule ? await this.reload() : { reloaded: false, hint: "no ingress change" };
    this.logger.info("undeployed", { hostname, removedRule, deletedRecords: deleted.length });
    return { hostname, removedRule, deletedRecords: deleted.length, reload };
  }

  /**
   * Reload cloudflared so a config change takes effect. Prefers the user systemd service; if it
   * isn't present we do NOT crash — we return a hint telling the human how to reload. (Never
   * disturbs Beckett's own service.)
   */
  private async reload(): Promise<{ reloaded: boolean; hint?: string }> {
    const r = await this.runCommand(["systemctl", "--user", "restart", "cloudflared"]);
    if (r.code === 0) return { reloaded: true };
    return {
      reloaded: false,
      hint:
        "could not auto-reload cloudflared (no `systemctl --user` cloudflared service). " +
        "Reload it manually so the new ingress takes effect, e.g. `systemctl --user restart " +
        "cloudflared` or restart your `cloudflared tunnel run` process.",
    };
  }
}

/** Default command runner (Bun.spawn), used for the cloudflared reload. */
async function defaultRunCommand(cmd: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stderr };
  } catch (err) {
    return { code: 127, stderr: (err as Error).message };
  }
}
