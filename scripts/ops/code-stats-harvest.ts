#!/usr/bin/env bun
import { defaultCodeStatsOptions, harvestCodeStats } from "../../src/code-stats/harvest.ts";

const options = defaultCodeStatsOptions();
const args = process.argv.slice(2);

function take(flag: string): string {
  const value = args.shift();
  if (!value) throw new Error(`${flag} requires a path`);
  return value;
}

while (args.length) {
  const flag = args.shift()!;
  switch (flag) {
    case "--output": options.output = take(flag); break;
    case "--projects-dir": options.projectsDir = take(flag); break;
    case "--help":
      console.log("Usage: bun run code-stats:refresh [--output PATH] [--projects-dir PATH]");
      process.exit(0);
    default: throw new Error(`unknown option: ${flag}`);
  }
}

await harvestCodeStats(options);
