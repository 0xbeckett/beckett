/**
 * beckett-forms edge worker — forms.0xbeckett.me
 *
 * Serves the static survey(s) in ./public and handles their submissions. There is
 * deliberately no database and no KV: a submission is validated here and forwarded
 * straight to a Discord webhook, then forgotten.
 *
 * Two things this worker owns before assets get a look-in (run_worker_first):
 *   1. `/`                -> 302 to /fair-price (the survey's canonical path).
 *   2. `POST /fair-price/submit` -> validate + forward to the Discord webhook.
 * Everything else falls through to the ASSETS binding (fair-price.html, page.css,
 * pricing-data.json, logo.svg).
 *
 * The Discord webhook URL is read from `env.FORMS_WEBHOOK_URL`, a secret Beckett
 * sets at deploy time. It is NEVER committed and there is NO hardcoded fallback —
 * if the secret is missing the worker returns a visible 500, it does not pretend
 * to succeed.
 *
 * The floor each numeric answer must clear ("at our cost") is read from the same
 * committed pricing-data.json the page shows, so the client and this worker reject
 * below-cost answers against one shared source of truth — nothing is re-derived.
 */

// Basic per-IP rate limit. In-memory per isolate — not a global guarantee, but
// enough to blunt a single client hammering the form. State resets when the
// isolate recycles, which is fine for a boring survey.
const RATE = { windowMs: 10 * 60 * 1000, max: 5, hits: new Map() };

function rateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE.windowMs;
  const seen = (RATE.hits.get(ip) || []).filter((t) => t > cutoff);
  seen.push(now);
  RATE.hits.set(ip, seen);
  // opportunistic cleanup so the Map can't grow without bound
  if (RATE.hits.size > 5000) {
    for (const [k, v] of RATE.hits) {
      if (!v.some((t) => t > cutoff)) RATE.hits.delete(k);
    }
  }
  return seen.length > RATE.max;
}

// The four line-item floors, derived from the committed pricing-data.json.
// Only compute has a non-zero dollar floor today; the percentage lines floor at
// 0 (0% markup / 0% margin == exactly our cost) and the seat is un-metered.
function floorsFrom(data) {
  return {
    model_markup_pct: { min: 0, label: "model cost markup" },
    compute_per_hour: {
      min: Number(data?.compute_rate?.per_hour ?? 0.5),
      label: "compute rate",
    },
    platform_fee_pct: { min: 0, label: "platform fee" },
    seat_monthly: { min: 0, label: "monthly seat" },
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleSubmit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return json(429, {
      ok: false,
      error: "You've submitted a few times already — give it ten minutes and try again.",
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Couldn't read your submission. Please try again." });
  }

  // Honeypot: a field no human ever fills. If it has content, accept-and-drop so
  // the bot believes it succeeded, but nothing is forwarded.
  if (payload && typeof payload.website === "string" && payload.website.trim() !== "") {
    return json(200, { ok: true });
  }

  // Pull the floors from the same committed data the page renders.
  let floors;
  try {
    const res = await env.ASSETS.fetch(new URL("/pricing-data.json", request.url));
    floors = floorsFrom(await res.json());
  } catch {
    floors = floorsFrom(null);
  }

  const answers = (payload && payload.answers) || {};
  const errors = [];
  const clean = {};
  for (const [key, spec] of Object.entries(floors)) {
    const raw = answers[key];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (raw === undefined || raw === null || raw === "" || Number.isNaN(n)) {
      errors.push(`${spec.label}: please enter a number.`);
      continue;
    }
    if (n < spec.min) {
      // Reject below-cost — never silently clamp.
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
    // No secret configured. Surface a real failure — do NOT report success.
    return json(500, {
      ok: false,
      error: "The form isn't accepting responses right now. Please try again later.",
    });
  }

  const unfair = typeof payload.unfair === "string" ? payload.unfair.trim().slice(0, 2000) : "";
  const content =
    "**New fair-price survey response**\n" +
    "```\n" +
    `model cost markup : ${clean.model_markup_pct}%\n` +
    `compute rate      : $${clean.compute_per_hour}/hr\n` +
    `platform fee      : ${clean.platform_fee_pct}%\n` +
    `monthly seat      : $${clean.seat_monthly}\n` +
    "```\n" +
    (unfair ? `**What would make this feel unfair:**\n> ${unfair.replace(/\n/g, "\n> ")}` : "_(no unfairness note left)_");

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      return json(502, {
        ok: false,
        error: "We couldn't record your response. Please try again in a moment.",
      });
    }
  } catch {
    return json(502, {
      ok: false,
      error: "We couldn't record your response. Please try again in a moment.",
    });
  }

  return json(200, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Root redirects to the survey. Leaves room for a second form later without a
    // rewrite — new forms just get their own /path and their own submit route.
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
  },
};
