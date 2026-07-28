#!/usr/bin/env bun

/** Capture a local page with BetterWright, without a separately-managed browser. */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BetterWright } from "betterwright";

interface Options {
  url: string;
  output: string;
  width: number;
  height: number;
  waitMs: number;
}

function usage(message?: string): never {
  if (message) process.stderr.write(`shot: ${message}\n`);
  process.stderr.write("usage: bun run shot <url> <out.png> [--width N] [--height N] [--wait ms]\n");
  process.exit(2);
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) usage(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const [url, output, ...rest] = argv;
  if (!url || !output) usage();

  let width = 1440;
  let height = 900;
  let waitMs = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[++index];
    if (flag === "--width") width = positiveInteger(value, flag);
    else if (flag === "--height") height = positiveInteger(value, flag);
    else if (flag === "--wait") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) usage("--wait must be a non-negative integer");
      waitMs = parsed;
    } else usage(`unknown option ${flag}`);
  }
  try {
    new URL(url);
  } catch {
    usage(`invalid URL ${JSON.stringify(url)}`);
  }
  return { url, output: resolve(output), width, height, waitMs };
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(dirname(options.output), { recursive: true });

// Keep all BetterWright state (including its browser profile) inside the current worktree.
const browser = new BetterWright({
  home: resolve(".shots", "betterwright"),
  headless: true,
  vault: false,
  defaultTimeout: 30,
});

try {
  const result = await browser.run(
    `
      await page.setViewportSize({ width: ${options.width}, height: ${options.height} });
      await page.goto(${JSON.stringify(options.url)}, { waitUntil: 'networkidle' });
      ${options.waitMs ? `await page.waitForTimeout(${options.waitMs});` : ""}
      await page.screenshot({ path: ${JSON.stringify(options.output)}, type: 'png' });
      return { url: page.url() };
    `,
    { timeout: 45 },
  );
  if (!result.ok) throw new Error(result.error);
  process.stdout.write(`wrote ${options.output}\n`);
} catch (error) {
  process.stderr.write(
    `shot: could not capture ${options.url}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
