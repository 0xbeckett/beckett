import { BetterWright, NetworkPolicy } from "betterwright";
const t0 = Date.now();
const bw = new BetterWright({
  headless: true,
  defaultTimeout: 30,
  policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: true }),
  downloadPolicy: "ask",
  publicSearchPolicy: "block",
});
try {
  const r = await bw.run("await goto('data:text/html,<h1>hi</h1>'); return 'ok';", { session: "probe" });
  console.log("LAUNCH_OK", Date.now()-t0, "ms", JSON.stringify({ok:r.ok, result:r.result, err:r.error}));
} catch (e) {
  console.log("LAUNCH_ERR", String(e).slice(0,400));
} finally {
  try { await bw.stop?.(); } catch {}
  try { await bw.close?.(); } catch {}
}
process.exit(0);
