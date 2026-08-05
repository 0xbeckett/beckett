// Wait for READY, capture RUNTIME INFO, submit a short prompt, let it finish, read the pill.
const ready = await page.evaluate(async () => {
  for (let i = 0; i < 300; i++) {
    if (/READY/i.test(document.body.innerText)) return "ready after ~" + i + "s";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "never became READY";
});

// What the app itself believes it is running on.
const runtimeInfo = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll("button")].find((b) => /RUNTIME INFO/i.test(b.textContent || ""));
  if (!btn) return "no RUNTIME INFO button";
  btn.click();
  await sleep(1500);
  const text = document.body.innerText.replace(/\s+/g, " ");
  const close = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "×");
  if (close) close.click();
  await sleep(800);
  return text.slice(0, 1400);
});

const run = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deepThink = [...document.querySelectorAll("button")].find((b) => /DEEP THINK/i.test(b.textContent || ""));
  const deepThinkState = deepThink
    ? `${deepThink.getAttribute("aria-pressed")}|${deepThink.className}`.slice(0, 160)
    : "absent";

  const field = document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
  if (!field) return { error: "no input field" };
  const prompt = "Say hello in exactly five words.";
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(field, prompt);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(400);

  const sendBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "↑" && !b.disabled);
  const t0 = performance.now();
  if (sendBtn) sendBtn.click();
  else field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  // Wall time from click until the app's own TTFT pill appears.
  let ttftPillMs = null;
  let ttftPillText = null;
  for (let i = 0; i < 9000; i++) {
    const t = document.body.innerText.replace(/\s+/g, " ");
    const m = t.match(/TTFT\s+[\d.]+\s*MS/i);
    if (m) { ttftPillMs = performance.now() - t0; ttftPillText = m[0]; break; }
    await sleep(200);
  }

  // Done when the stop control (■) disappears.
  let settledMs = null;
  for (let i = 0; i < 18000; i++) {
    const stopping = [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "■");
    if (!stopping && i > 10) { settledMs = performance.now() - t0; break; }
    await sleep(200);
  }
  await sleep(3000);

  const text = document.body.innerText.replace(/\s+/g, " ");
  const stats = (text.match(/(TTFT|TOK\/S|TOKENS\/S|[\d.]+\s*TOK)[^|]{0,60}/gi) || []).slice(-10);
  return { deepThinkState, ttftPillMs, ttftPillText, settledMs, stats, tail: text.slice(-900) };
});

return JSON.stringify({ ready, runtimeInfo, ...run }, null, 1);
