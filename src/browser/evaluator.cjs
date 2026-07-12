#!/usr/bin/env node
"use strict";

// Untrusted code runner. Production starts this file in a separate bubblewrap namespace that can
// reach Chromium over loopback but cannot see the profile, artifacts, Beckett state, or host PID.

const { chromium } = require("playwright");
const { createContext, runInContext } = require("node:vm");
const { inspect } = require("node:util");

const MAX_INPUT_CHARS = 1_000_000;
const MAX_CODE_CHARS = 100_000;
const MAX_LOG_CHARS = 12_000;
const MAX_SCREENSHOTS = 3;

async function readInput() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk.toString("utf8");
    if (body.length > MAX_INPUT_CHARS) throw new Error("evaluator input exceeded size limit");
  }
  return JSON.parse(body);
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function normalize(value, maxChars) {
  if (value === undefined) return { value: null, truncated: false };
  if (typeof value === "string") {
    const limited = truncate(value, maxChars);
    return { value: limited.text, truncated: limited.truncated };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value, truncated: false };
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { value: String(value), truncated: false };
    const limited = truncate(json, maxChars);
    return { value: limited.truncated ? limited.text : JSON.parse(json), truncated: limited.truncated };
  } catch {
    return { value: "[non-serializable Playwright value; return plain data instead]", truncated: false };
  }
}

function safeState(value) {
  if (!value || typeof value !== "object") return Object.create(null);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Object.create(null);
  }
}

async function main() {
  const input = await readInput();
  if (typeof input.endpoint !== "string" || !input.endpoint.startsWith("http://127.0.0.1:")) {
    throw new Error("invalid evaluator CDP endpoint");
  }
  if (typeof input.origin !== "string" || !/^https:\/\/[a-f0-9]{48}\.beckett\.invalid$/.test(input.origin)) {
    throw new Error("invalid evaluator CDP origin");
  }
  if (typeof input.code !== "string" || !input.code.trim()) throw new Error("playwright_eval needs JavaScript");
  if (input.code.length > MAX_CODE_CHARS) throw new Error(`playwright_eval code exceeds ${MAX_CODE_CHARS} characters`);
  const actionTimeoutMs = Number(input.actionTimeoutMs);
  const evalTimeoutMs = Number(input.evalTimeoutMs);
  const maxOutputChars = Number(input.maxOutputChars);
  const browser = await chromium.connectOverCDP(input.endpoint, {
    timeout: actionTimeoutMs,
    headers: { Origin: input.origin },
  });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("persistent Chromium context is unavailable");
    context.setDefaultTimeout(actionTimeoutMs);
    context.setDefaultNavigationTimeout(Number(input.navigationTimeoutMs));
    let pages = context.pages().filter((page) => !page.isClosed());
    if (pages.length === 0) pages = [await context.newPage()];
    const trustedNewCdpSession = context.newCDPSession.bind(context);
    const pageTargetId = async (target) => {
      const session = await trustedNewCdpSession(target);
      try {
        const result = await session.send("Target.getTargetInfo");
        return result.targetInfo?.targetId || "";
      } finally {
        await session.detach().catch(() => undefined);
      }
    };
    let activePage;
    if (typeof input.activeTargetId === "string" && input.activeTargetId) {
      const targetIds = await Promise.all(pages.map((candidate) => pageTargetId(candidate).catch(() => "")));
      activePage = pages[targetIds.indexOf(input.activeTargetId)];
    }
    activePage ||= pages[Math.min(Number(input.activeIndex) || 0, pages.length - 1)] || pages[0];
    const state = safeState(input.state);
    const screenshotRequests = [];
    const logs = [];
    let logChars = 0;
    let outputWasTruncated = false;

    const pushLog = (prefix, values) => {
      if (logChars >= MAX_LOG_CHARS || logs.length >= 20) return;
      const line = prefix + values.map((value) =>
        typeof value === "string" ? value : inspect(value, { depth: 3, breakLength: 120 })
      ).join(" ");
      const remaining = MAX_LOG_CHARS - logChars;
      const clipped = line.slice(0, remaining);
      logs.push(clipped);
      logChars += clipped.length;
      outputWasTruncated ||= clipped.length < line.length;
    };
    const consoleFacade = {
      log: (...values) => pushLog("", values),
      info: (...values) => pushLog("", values),
      warn: (...values) => pushLog("[warn] ", values),
      error: (...values) => pushLog("[error] ", values),
    };
    let sandbox;
    const usePage = (target) => {
      const currentPages = context.pages().filter((page) => !page.isClosed());
      const selected = typeof target === "number" ? currentPages[target] : target;
      if (!selected || selected.isClosed() || !currentPages.includes(selected)) throw new Error("page is not open");
      activePage = selected;
      pages = currentPages;
      if (sandbox) {
        sandbox.page = activePage;
        sandbox.pages = pages;
      }
      return selected;
    };
    const contextFacade = new Proxy(context, {
      get(target, property) {
        if (property === "close") return async () => { throw new Error("the persistent browser context is host-owned"); };
        if (property === "newPage") return async () => usePage(await target.newPage());
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(context, "close", {
      configurable: true,
      value: async () => { throw new Error("the persistent browser context is host-owned"); },
    });
    Object.defineProperty(context, "browser", {
      configurable: true,
      value: () => null,
    });
    Object.defineProperty(context, "_browser", {
      configurable: true,
      value: null,
    });
    Object.defineProperty(context, "newCDPSession", {
      configurable: true,
      value: async () => { throw new Error("raw CDP sessions are controller-owned"); },
    });
    const observe = async (target = activePage, options = {}) => {
      const snapshot = await target.ariaSnapshot({
        mode: "ai",
        boxes: options.boxes ?? false,
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        timeout: actionTimeoutMs,
      });
      const limited = truncate(snapshot, options.maxChars ?? maxOutputChars);
      outputWasTruncated ||= limited.truncated;
      return limited.text;
    };
    const screenshot = async (name = "screenshot", target = activePage) => {
      if (screenshotRequests.length >= MAX_SCREENSHOTS) {
        throw new Error(`playwright_eval allows at most ${MAX_SCREENSHOTS} screenshots`);
      }
      const currentPages = context.pages().filter((page) => !page.isClosed());
      const index = currentPages.indexOf(target);
      if (index < 0) throw new Error("screenshot target is not open");
      screenshotRequests.push({
        name: String(name),
        pageIndex: index,
        targetId: await pageTargetId(target).catch(() => ""),
      });
      return `[screenshot queued: ${String(name)}]`;
    };

    sandbox = createContext({
      page: activePage,
      context: contextFacade,
      pages,
      state,
      observe,
      snapshot: observe,
      usePage,
      screenshot,
      console: consoleFacade,
    });
    const startedAt = Date.now();
    let timer;
    let value;
    let evaluationError = null;
    try {
      const pending = runInContext(`(async () => {\n${input.code}\n})()`, sandbox, {
        timeout: Math.min(evalTimeoutMs, 5_000),
      });
      value = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`playwright_eval timed out after ${evalTimeoutMs}ms`)), evalTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (error) {
      evaluationError = String(error?.message ?? error).slice(0, 2_000);
      if (/tim(?:eout|ed out)/i.test(evaluationError)) {
        evaluationError += "; browser-side work may have continued, so the outcome is uncertain. Inspect current state before retrying any action";
      }
    }
    const normalized = evaluationError ? { value: null, truncated: false } : normalize(value, maxOutputChars);
    outputWasTruncated ||= normalized.truncated;
    const currentPages = context.pages().filter((page) => !page.isClosed());
    const activeTargetId = await pageTargetId(activePage).catch(() => "");
    process.stdout.write(JSON.stringify({
      ok: !evaluationError,
      ...(evaluationError ? { error: evaluationError } : {}),
      ...(evaluationError ? { recoverable: true } : {}),
      value: normalized.value,
      console: logs,
      state: safeState(state),
      activeIndex: Math.max(0, currentPages.indexOf(activePage)),
      activeTargetId,
      screenshotRequests: evaluationError ? [] : screenshotRequests,
      elapsedMs: Date.now() - startedAt,
      truncated: outputWasTruncated,
    }) + "\n");
    if (evaluationError) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 2_000) }) + "\n");
  process.exitCode = 1;
});
