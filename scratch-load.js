await page.goto("https://procreations-maple-webgpu.static.hf.space/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
// Record page errors + failed requests so a later failure has evidence rather than a guess.
await page.evaluate(() => {
  window.__probe = { errors: [], failed: [], startedAt: Date.now() };
  window.addEventListener("error", (e) => window.__probe.errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__probe.errors.push("rejection: " + String(e.reason)));
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    try {
      const res = await origFetch(...args);
      if (!res.ok) window.__probe.failed.push(`${res.status} ${url}`);
      return res;
    } catch (err) {
      window.__probe.failed.push(`threw ${String(err && err.message)} ${url}`);
      throw err;
    }
  };
});
// Click through the DOM: this lane's `page` builds CSS selectors from getByRole options,
// so a text/regex match has to happen in-page.
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")]
    .filter((b) => /LOAD MAPLE/i.test(b.textContent || ""))
    .find((b) => b.offsetParent !== null);
  if (!btn) return "no visible LOAD MAPLE button";
  btn.click();
  return "clicked: " + btn.textContent.trim();
});
await page.waitForTimeout(5000);
const state = await page.evaluate(async () => {
  const est = await navigator.storage.estimate();
  return { quota: est.quota, usage: est.usage, probe: window.__probe, text: document.body.innerText.replace(/\s+/g, " ").slice(0, 400) };
});
return JSON.stringify({ clicked, ...state });
