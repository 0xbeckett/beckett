import { BetterWright, NetworkPolicy } from "betterwright";
const TABS = Number(process.env.TABS || 5);
const HOLD = Number(process.env.HOLD_MS || 22000);
const anim = "data:text/html,<body><script>function f(){document.title=Math.random();requestAnimationFrame(f)}requestAnimationFrame(f)</" + "script></body>";
const bw = new BetterWright({
  headless: true, defaultTimeout: 30,
  policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: true }),
  downloadPolicy: "ask", publicSearchPolicy: "block",
});
const q = (s) => JSON.stringify(s);
// first tab
await bw.run("await page.goto(" + q(anim) + "); return 'ok';", { session: "bench" });
// remaining tabs in same session
for (let i = 1; i < TABS; i++) {
  await bw.run("const p = await context.newPage(); await p.goto(" + q(anim) + "); return 'ok';", { session: "bench" });
}
console.log("READY " + process.pid);
await new Promise((r) => setTimeout(r, HOLD));
try { await bw.stop?.(); } catch {}
try { await bw.close?.(); } catch {}
process.exit(0);
