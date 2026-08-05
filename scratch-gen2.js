// Generation measurement with a window sized for a software-rendered backend, and its own
// token accounting so a number exists even if the app's stats pill never renders.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ready = await page.evaluate(async () => {
  for (let i = 0; i < 600; i++) {
    if (/READY/i.test(document.body.innerText)) return "ready after ~" + i + "s";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "never became READY";
});

const runtimeInfo = await page.evaluate(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll("button")].find((b) => /RUNTIME INFO/i.test(b.textContent || ""));
  if (!btn) return "no RUNTIME INFO button";
  btn.click();
  await nap(1500);
  const text = document.body.innerText.replace(/\s+/g, " ");
  const close = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "×");
  if (close) close.click();
  await nap(800);
  return text.slice(0, 1200);
});

const run = await page.evaluate(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const field = document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
  if (!field) return { error: "no input field" };
  const before = document.body.innerText;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(field, "Say hello.");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await nap(400);

  const sendBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "↑" && !b.disabled);
  const t0 = performance.now();
  if (sendBtn) sendBtn.click();
  else field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  // Two independent clocks: the app's own stats pill, and wall time to the first and last
  // character of new text on the page. The second one holds up even if the pill never renders.
  let pillText = null;
  let pillAtMs = null;
  let firstTextMs = null;
  let lastGrowthMs = null;
  let lastLen = 0;
  let stoppedMs = null;
  const samples = [];

  for (let i = 0; i < 5400; i++) {  // up to ~45 min at 500ms
    const text = document.body.innerText;
    const flat = text.replace(/\s+/g, " ");
    const grown = Math.max(0, text.length - before.length);
    if (firstTextMs === null && grown > 24) firstTextMs = performance.now() - t0;
    if (grown > lastLen) { lastLen = grown; lastGrowthMs = performance.now() - t0; }
    if (pillText === null) {
      const m = flat.match(/TTFT[^A-Za-z0-9]{0,3}[\d.]+\s*(MS|S)\b/i);
      if (m) { pillText = m[0]; pillAtMs = performance.now() - t0; }
    }
    if (i % 60 === 0) samples.push({ atSec: Math.round((performance.now() - t0) / 1000), chars: grown });
    const stopping = [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "■");
    if (!stopping && i > 20 && firstTextMs !== null) { stoppedMs = performance.now() - t0; break; }
    await nap(500);
  }
  await nap(2000);

  const flat = document.body.innerText.replace(/\s+/g, " ");
  const stats = (flat.match(/(TTFT|TOK\/S|TOKENS\/SEC|TOK\/SEC|[\d.]+\s*TOK)[^|]{0,50}/gi) || []).slice(-8);
  return {
    pillText,
    pillAtMs,
    firstTextMs,
    lastGrowthMs,
    stoppedMs,
    grownChars: lastLen,
    samples: samples.slice(-14),
    stats,
    tail: flat.slice(-800),
  };
});

return JSON.stringify({ ready, runtimeInfo, ...run }, null, 1);
