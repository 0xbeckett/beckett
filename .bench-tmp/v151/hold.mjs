import { BetterWright, NetworkPolicy } from "betterwright";
const TABS = Number(process.env.TABS || 5);
const HOLD = Number(process.env.HOLD_MS || 30000);
// Heavy animated page: 200 boxes moved every rAF frame -> forces layout+paint+composite,
// which is exactly the idle CPU that 1.6.1's background-page parking eliminates.
const html = [
  "<body style='margin:0'><div id=w></div><script>",
  "var w=document.getElementById('w');var b=[];",
  "for(var i=0;i<200;i++){var d=document.createElement('div');",
  "d.style.cssText='position:absolute;width:40px;height:40px;background:hsl('+i+',80%,50%)';",
  "w.appendChild(d);b.push(d);}",
  "var t=0;function f(){t+=0.05;for(var i=0;i<b.length;i++){",
  "b[i].style.transform='translate('+(200+150*Math.sin(t+i))+'px,'+(200+150*Math.cos(t+i))+'px)';}",
  "requestAnimationFrame(f);}requestAnimationFrame(f);",
  "</scr" + "ipt></body>",
].join("");
const anim = "data:text/html," + encodeURIComponent(html);
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
