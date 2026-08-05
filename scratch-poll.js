// Poll the load: storage usage is the direct signal that shards are landing in CacheStorage.
const samples = [];
for (let i = 0; i < 45; i++) {
  const snap = await page.evaluate(async () => {
    const est = await navigator.storage.estimate();
    return {
      t: Date.now(),
      usage: est.usage,
      quota: est.quota,
      errors: (window.__probe?.errors ?? []).slice(-3),
      failed: (window.__probe?.failed ?? []).slice(-3),
      text: document.body.innerText.replace(/\s+/g, " ").slice(0, 260),
    };
  });
  samples.push(snap);
  const done = /ready|loaded|generat|ask|message/i.test(snap.text) && snap.usage > 5.0e9;
  if (done) break;
  await page.waitForTimeout(15000);
}
const first = samples[0], last = samples[samples.length - 1];
const secs = (last.t - first.t) / 1000;
return JSON.stringify({
  usageStart: first.usage,
  usageEnd: last.usage,
  quota: last.quota,
  elapsedSec: secs,
  mibPerSec: secs > 0 ? Math.round((last.usage - first.usage) / 1048576 / secs) : null,
  errors: last.errors,
  failed: last.failed,
  text: last.text,
}, null, 1);
