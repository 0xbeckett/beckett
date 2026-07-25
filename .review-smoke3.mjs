import { BetterWright, NetworkPolicy } from "./node_modules/betterwright/dist/src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bw-smoke3-"));
const browser = new BetterWright({
  home,
  headless: true,
  defaultTimeout: 30,
  policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: true }),
  downloadPolicy: "deny",
  publicSearchPolicy: "block",
});

const result = await browser.run("return page.url()", { session: "default" });
console.log(JSON.stringify(result, null, 2));
await browser.close();
