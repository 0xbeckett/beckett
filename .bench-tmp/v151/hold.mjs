import { BetterWright, NetworkPolicy } from "betterwright";
const TABS = Number(process.env.TABS || 5);
const HOLD = Number(process.env.HOLD_MS || 25000);
const anim = "data:text/html,<body><script>function f(){document.title=Math.random();requestAnimationFrame(f)}requestAnimationFrame(f)</" + "script></body>";
const bw = new BetterWright({
  headless: true, defaultTimeout: 30,
  policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: true }),
  downloadPolicy: "ask", publicSearchPolicy: "block",
});
const q = (s) => JSON.stringify(s);
const t0 = Date.now();
await bw.run("await page.goto(" + q(anim) + "); return 'ok';", { session: "bench" });
for (let i = 1; i < TABS; i++) {
  await bw.run("const p = await context.newPage(); await p.goto(" + q(anim) + "); return 'ok';", { session: "bench" });
}
const openMs = Date.now() - t0;
// speed probe: 10 back-to-back evals (agent-style round trips) after tabs are up
const t1 = Date.now();
const N = 10;
for (let i = 0; i < N; i++) {
  await bw.run("return await page.evaluate(() => document.title);", { session: "bench" });
}
const evalMs = (Date.now() - t1) / N;
console.log("SPEED openMs=" + openMs + " evalMs=" + evalMs.toFixed(1));
console.log("READY " + process.pid);
await new Promise((r) => setTimeout(r, HOLD));
try { await bw.stop?.(); } catch {}
try { await bw.close?.(); } catch {}
process.exit(0);
