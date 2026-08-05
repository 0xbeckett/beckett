await page.goto("https://procreations-maple-webgpu.static.hf.space/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
return await page.evaluate(async () => {
  const est = await navigator.storage.estimate();
  let gpu = "no navigator.gpu";
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) gpu = "requestAdapter() -> null";
      else {
        const info = adapter.info ?? {};
        gpu = `adapter ok vendor=${info.vendor ?? "?"} arch=${info.architecture ?? "?"} desc=${info.description ?? "?"} maxBuffer=${adapter.limits?.maxBufferSize} maxStorageBinding=${adapter.limits?.maxStorageBufferBindingSize}`;
      }
    }
  } catch (e) { gpu = "gpu error: " + e.message; }
  const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean);
  return JSON.stringify({
    origin: location.origin,
    title: document.title,
    quota: est.quota,
    usage: est.usage,
    gpu,
    buttons: buttons.slice(0, 20),
    bodyText: document.body.innerText.slice(0, 600),
  }, null, 1);
});
