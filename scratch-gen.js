// Wait for READY, submit a prompt, then read the space's own TTFT / tok/s pill.
const ready = await page.evaluate(async () => {
  for (let i = 0; i < 120; i++) {
    if (/READY/i.test(document.body.innerText)) return "ready after " + i + "s";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "never became READY: " + document.body.innerText.replace(/\s+/g, " ").slice(0, 300);
});

const run = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const field = document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
  if (!field) return { error: "no input field" };

  const prompt = "In one short paragraph, explain why the sky is blue.";
  if (field.tagName === "TEXTAREA") {
    // React tracks the value; bypass its tracker so the input event is believed.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(field, prompt);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    field.textContent = prompt;
    field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
  await sleep(300);

  const bodyBefore = document.body.innerText;
  const sendBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "↑" && !b.disabled);
  const t0 = performance.now();
  if (sendBtn) sendBtn.click();
  else field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  // TTFT measured in-page: first moment new response text is painted.
  let ttftMs = null;
  for (let i = 0; i < 1200; i++) {
    const now = document.body.innerText;
    if (now.length > bodyBefore.length + 40 && !/^\s*$/.test(now.slice(bodyBefore.length))) {
      ttftMs = performance.now() - t0;
      break;
    }
    await sleep(100);
  }

  // Generation is done when the stop control (■) goes away.
  let settledMs = null;
  for (let i = 0; i < 3000; i++) {
    const stopping = [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "■");
    if (!stopping && i > 5) { settledMs = performance.now() - t0; break; }
    await sleep(100);
  }
  await sleep(2500);

  const text = document.body.innerText.replace(/\s+/g, " ");
  // The pill prints the space's own measurements; capture every candidate fragment.
  const pill = (text.match(/[^.|]*(TTFT|tok\/s|tokens\/s|tok\/sec|ms\b)[^.|]*/gi) || []).slice(-8);
  return { ttftMs, settledMs, pill, tail: text.slice(-700) };
});

return JSON.stringify({ ready, ...run }, null, 1);
