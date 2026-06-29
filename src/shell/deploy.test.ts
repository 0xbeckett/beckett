/**
 * Beckett — tunnel deploy tests (`src/shell/deploy.test.ts`)
 * =======================================================================================
 * Verifies the cloudflared `config.yml` read→modify→write round-trip stays robust and that
 * the `http_status:404` catch-all is always kept last. These are the parts of `beckett deploy`
 * that can be tested WITHOUT a live tunnel; the CNAME step reuses the (live-tested) {@link CfDns}.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTunnelConfig,
  renderTunnelConfig,
  TunnelDeployer,
  TunnelNotConfiguredError,
} from "./deploy.ts";
import { CfDns } from "../agency/cloudflare.ts";

const SAMPLE = `tunnel: abc-123
credentials-file: /home/beckett/.cloudflared/abc-123.json
ingress:
  - hostname: a.0xbeckett.me
    service: http://localhost:3000
  - hostname: b.0xbeckett.me
    service: http://localhost:4000
  - service: http_status:404
`;

describe("parse/render round-trip", () => {
  test("parses the known shape", () => {
    const cfg = parseTunnelConfig(SAMPLE);
    expect(cfg.tunnel).toBe("abc-123");
    expect(cfg.credentialsFile).toBe("/home/beckett/.cloudflared/abc-123.json");
    expect(cfg.ingress).toHaveLength(3);
    expect(cfg.ingress[0]).toEqual({ hostname: "a.0xbeckett.me", service: "http://localhost:3000" });
    expect(cfg.ingress[2]).toEqual({ service: "http_status:404" });
  });

  test("round-trips byte-stable", () => {
    expect(renderTunnelConfig(parseTunnelConfig(SAMPLE))).toBe(SAMPLE);
  });

  test("catch-all is forced last even if mis-ordered", () => {
    const misordered = `tunnel: t1
ingress:
  - service: http_status:404
  - hostname: x.0xbeckett.me
    service: http://localhost:9
`;
    const rendered = renderTunnelConfig(parseTunnelConfig(misordered));
    const lines = rendered.trim().split("\n");
    expect(lines[lines.length - 1]).toBe("  - service: http_status:404");
  });

  test("preserves unknown top-level keys and per-rule extra lines", () => {
    const withExtras = `tunnel: t1
warp-routing:
  enabled: true
ingress:
  - hostname: x.0xbeckett.me
    service: http://localhost:9
    originRequest:
  - service: http_status:404
`;
    const rendered = renderTunnelConfig(parseTunnelConfig(withExtras));
    expect(rendered).toContain("warp-routing:");
    expect(rendered).toContain("originRequest:");
  });
});

/** A CfDns stand-in that records calls without touching the network. */
function fakeDns() {
  const calls: { upserts: unknown[]; removes: unknown[] } = { upserts: [], removes: [] };
  const dns = {
    async zoneName() {
      return "0xbeckett.me";
    },
    async upsert(p: unknown) {
      calls.upserts.push(p);
      return p;
    },
    async remove(name: string, type?: string) {
      calls.removes.push({ name, type });
      return { deleted: [] };
    },
  } as unknown as CfDns;
  return { dns, calls };
}

describe("TunnelDeployer", () => {
  test("missing tunnel id fails cleanly", () => {
    const { dns } = fakeDns();
    const deployer = new TunnelDeployer({ dns, logger: console as never });
    expect(() => deployer.list()).toThrow(TunnelNotConfiguredError);
  });

  test("deploy creates default config, ingress rule, and CNAME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-deploy-"));
    const configPath = join(dir, "config.yml");
    const { dns, calls } = fakeDns();
    const deployer = new TunnelDeployer({
      tunnelId: "tid-9",
      dns,
      logger: console as never,
      configPath,
      runCommand: async () => ({ code: 1, stderr: "no service" }),
    });

    const res = await deployer.deploy({ name: "demo", service: "http://localhost:5173" });
    expect(res.url).toBe("https://demo.0xbeckett.me");
    expect(res.reload.reloaded).toBe(false); // no systemd in test → graceful hint
    expect(res.reload.hint).toBeTruthy();

    const written = readFileSync(configPath, "utf8");
    expect(written).toContain("hostname: demo.0xbeckett.me");
    expect(written).toContain("service: http://localhost:5173");
    expect(written.trim().endsWith("- service: http_status:404")).toBe(true);

    expect(calls.upserts).toHaveLength(1);
    expect((calls.upserts[0] as { content: string }).content).toBe("tid-9.cfargotunnel.com");
  });

  test("deploy is idempotent (replaces the rule, no duplicate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-deploy-"));
    const configPath = join(dir, "config.yml");
    const { dns } = fakeDns();
    const deployer = new TunnelDeployer({
      tunnelId: "tid-9",
      dns,
      logger: console as never,
      configPath,
      runCommand: async () => ({ code: 0, stderr: "" }),
    });
    await deployer.deploy({ name: "demo", service: "http://localhost:1" });
    await deployer.deploy({ name: "demo", service: "http://localhost:2" });
    expect(deployer.list()).toEqual([{ hostname: "demo.0xbeckett.me", service: "http://localhost:2" }]);
  });

  test("remove drops the rule and deletes the CNAME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-deploy-"));
    const configPath = join(dir, "config.yml");
    writeFileSync(configPath, SAMPLE);
    const { dns, calls } = fakeDns();
    const deployer = new TunnelDeployer({
      tunnelId: "abc-123",
      dns,
      logger: console as never,
      configPath,
      runCommand: async () => ({ code: 0, stderr: "" }),
    });
    const res = await deployer.remove("a");
    expect(res.removedRule).toBe(true);
    expect(deployer.list()).toEqual([{ hostname: "b.0xbeckett.me", service: "http://localhost:4000" }]);
    expect(calls.removes).toEqual([{ name: "a.0xbeckett.me", type: "CNAME" }]);
  });
});
