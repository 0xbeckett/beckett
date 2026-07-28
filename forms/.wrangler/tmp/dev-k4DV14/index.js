var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var RATE = { windowMs: 10 * 60 * 1e3, max: 5, hits: /* @__PURE__ */ new Map() };
function rateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE.windowMs;
  const seen = (RATE.hits.get(ip) || []).filter((t) => t > cutoff);
  seen.push(now);
  RATE.hits.set(ip, seen);
  if (RATE.hits.size > 5e3) {
    for (const [k, v] of RATE.hits) {
      if (!v.some((t) => t > cutoff)) RATE.hits.delete(k);
    }
  }
  return seen.length > RATE.max;
}
__name(rateLimited, "rateLimited");
function floorsFrom(data) {
  return {
    model_markup_pct: { min: 0, label: "model cost markup" },
    compute_per_hour: {
      min: Number(data?.compute_rate?.per_hour ?? 0.5),
      label: "compute rate"
    },
    platform_fee_pct: { min: 0, label: "platform fee" },
    seat_monthly: { min: 0, label: "monthly seat" }
  };
}
__name(floorsFrom, "floorsFrom");
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
async function handleSubmit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return json(429, {
      ok: false,
      error: "You've submitted a few times already \u2014 give it ten minutes and try again."
    });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Couldn't read your submission. Please try again." });
  }
  if (payload && typeof payload.website === "string" && payload.website.trim() !== "") {
    return json(200, { ok: true });
  }
  let floors;
  try {
    const res = await env.ASSETS.fetch(new URL("/pricing-data.json", request.url));
    floors = floorsFrom(await res.json());
  } catch {
    floors = floorsFrom(null);
  }
  const answers = payload && payload.answers || {};
  const errors = [];
  const clean = {};
  for (const [key, spec] of Object.entries(floors)) {
    const raw = answers[key];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (raw === void 0 || raw === null || raw === "" || Number.isNaN(n)) {
      errors.push(`${spec.label}: please enter a number.`);
      continue;
    }
    if (n < spec.min) {
      errors.push(`${spec.label}: ${n} is below our cost of ${spec.min}. Pick a number at or above it.`);
      continue;
    }
    clean[key] = n;
  }
  if (errors.length) {
    return json(422, { ok: false, error: errors.join(" ") });
  }
  const webhook = env.FORMS_WEBHOOK_URL;
  if (!webhook) {
    return json(500, {
      ok: false,
      error: "The form isn't accepting responses right now. Please try again later."
    });
  }
  const unfair = typeof payload.unfair === "string" ? payload.unfair.trim().slice(0, 2e3) : "";
  const content = `**New fair-price survey response**
\`\`\`
model cost markup : ${clean.model_markup_pct}%
compute rate      : $${clean.compute_per_hour}/hr
platform fee      : ${clean.platform_fee_pct}%
monthly seat      : $${clean.seat_monthly}
\`\`\`
` + (unfair ? `**What would make this feel unfair:**
> ${unfair.replace(/\n/g, "\n> ")}` : "_(no unfairness note left)_");
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    });
    if (!res.ok) {
      return json(502, {
        ok: false,
        error: "We couldn't record your response. Please try again in a moment."
      });
    }
  } catch {
    return json(502, {
      ok: false,
      error: "We couldn't record your response. Please try again in a moment."
    });
  }
  return json(200, { ok: true });
}
__name(handleSubmit, "handleSubmit");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.redirect(new URL("/fair-price", url).toString(), 302);
    }
    if (url.pathname === "/fair-price/submit") {
      if (request.method !== "POST") {
        return json(405, { ok: false, error: "Method not allowed." });
      }
      return handleSubmit(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};

// ../../../../../../.bun/install/global/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../../.bun/install/global/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-VRkdrN/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../../.bun/install/global/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-VRkdrN/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
