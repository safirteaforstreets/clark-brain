/*
 * Clark AI — backend "brain"  (Phase 2)
 * --------------------------------------------------------------------------
 * Azure Functions v4 (Node 18+). Holds the LLM key server-side, grounds every
 * answer in the live Tea For Streets corpus, returns structured JSON.
 *
 * Deploy: see Clark_AI_Live_Deploy_Runbook.md.
 * PROVIDER (auto-selected by which env vars are set; checked in this order):
 *   1) Azure OpenAI — COVERED BY AZURE STARTUP CREDITS (recommended for TFS).
 *        AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT (e.g. gpt-4o), and
 *        AZURE_OPENAI_RESOURCE (or AZURE_OPENAI_ENDPOINT). Optional
 *        AZURE_OPENAI_API_VERSION (default 2024-10-21). Uses JSON mode for a
 *        guaranteed-parseable reply.
 *   2) Microsoft Foundry (Claude on Azure) — ANTHROPIC_FOUNDRY_API_KEY +
 *        ANTHROPIC_FOUNDRY_RESOURCE (or _BASE_URL). Claude is NOT credit-covered.
 *   3) Direct Anthropic API — ANTHROPIC_API_KEY. Claude is NOT credit-covered.
 *   - Optional: CLARK_MODEL (Claude paths, default claude-sonnet-4-6),
 *               CORS_ORIGIN (default https://report.teaforstreets.app; may be comma-separated)
 *   - Abuse guards: origin allow-list (CORS_ORIGIN), per-session turn cap
 *               (CLARK_MAX_TURNS=16), best-effort per-IP throttle
 *               (CLARK_RL_PER_MIN=20, CLARK_RL_PER_DAY=300) + a global daily
 *               call ceiling (CLARK_MAX_CALLS_PER_DAY=1500). Pair with a low
 *               Function App max-instance count to bound worst-case burn;
 *               an edge WAF (Front Door) is the upgrade for real traffic.
 *   - Cost control: Claude paths send the system prompt + corpus with prompt caching
 *     (~90% off repeat input); Azure OpenAI caches large prompts automatically.
 *
 * Portable: the handler core is host-agnostic. For Cloudflare Workers / Vercel,
 * keep clarkBrain() and swap the thin Azure wrapper at the bottom.
 */

const MODEL = process.env.CLARK_MODEL || "claude-sonnet-4-6";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://report.teaforstreets.app";
const CORPUS_BASE = "https://report.teaforstreets.app";

/* Provider: direct Anthropic API by default; Microsoft Foundry if its env vars are set. */
const FOUNDRY_KEY = process.env.ANTHROPIC_FOUNDRY_API_KEY || "";
const FOUNDRY_RES = process.env.ANTHROPIC_FOUNDRY_RESOURCE || "";
const FOUNDRY_BASE = process.env.ANTHROPIC_FOUNDRY_BASE_URL || "";
const USE_FOUNDRY = !!(FOUNDRY_KEY && (FOUNDRY_RES || FOUNDRY_BASE));
const API_KEY = USE_FOUNDRY ? FOUNDRY_KEY : (process.env.ANTHROPIC_API_KEY || "");
const ENDPOINT = (USE_FOUNDRY
  ? (FOUNDRY_BASE ? FOUNDRY_BASE.replace(/\/+$/, "") : "https://" + FOUNDRY_RES + ".services.ai.azure.com/anthropic")
  : "https://api.anthropic.com") + "/v1/messages";

/* Azure OpenAI (GPT) — covered by Azure startup credits. Takes priority when configured. */
const AOAI_KEY = process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY || "";
const AOAI_RES = process.env.AZURE_OPENAI_RESOURCE || "";
const AOAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
const AOAI_DEPLOY = process.env.AZURE_OPENAI_DEPLOYMENT || "";
const AOAI_VER = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
const USE_AOAI = !!(AOAI_KEY && AOAI_DEPLOY && (AOAI_RES || AOAI_ENDPOINT));

/* ---- Abuse guardrails (cheap, defense-in-depth). The AUTHORITATIVE per-IP
   limit belongs at the edge (API Management / Front Door); these cut casual
   abuse and the Azure budget alert is the hard backstop. ---- */
const ALLOWED_ORIGINS = CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
const MAX_TURNS  = parseInt(process.env.CLARK_MAX_TURNS  || "16", 10);   // user messages per conversation
const RL_PER_MIN = parseInt(process.env.CLARK_RL_PER_MIN || "20", 10);   // best-effort per-IP / minute (warm instance)
const RL_PER_DAY = parseInt(process.env.CLARK_RL_PER_DAY || "300", 10);  // best-effort per-IP / day    (warm instance)
const MAX_CALLS_DAY = parseInt(process.env.CLARK_MAX_CALLS_PER_DAY || "1500", 10); // global model-call ceiling / instance / day

const _rl = new Map();   // ip -> { min:{t,c}, day:{t,c} } — per warm instance; resets on cold start
function rateLimited(ip) {
  if (!ip) return false;                          // no IP (server-to-server/health) — let through; edge + budget cover it
  const now = Date.now();
  let e = _rl.get(ip);
  if (!e) { e = { min: { t: now, c: 0 }, day: { t: now, c: 0 } }; _rl.set(ip, e); }
  if (now - e.min.t > 60000)    { e.min.t = now; e.min.c = 0; }
  if (now - e.day.t > 86400000) { e.day.t = now; e.day.c = 0; }
  e.min.c++; e.day.c++;
  if (_rl.size > 5000) { for (const [k, v] of _rl) if (now - v.day.t > 86400000) _rl.delete(k); }
  return e.min.c > RL_PER_MIN || e.day.c > RL_PER_DAY;
}
let _glob = { t: Date.now(), c: 0 };       // global model-call counter (per warm instance; resets daily / on cold start)
function dailyCeilingHit() {
  const now = Date.now();
  if (now - _glob.t > 86400000) { _glob.t = now; _glob.c = 0; }
  _glob.c++;
  return _glob.c > MAX_CALLS_DAY;
}
function originAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.includes(origin);   // empty origin (non-browser) allowed; spoofable, so not the main guard
}
function corsHeaders(origin) {
  const allow = (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type"
  };
}

const SYSTEM = `You are Clark — "Clark the Cup," the Tea For Streets assistant. A resident tells you, in their own words, what's wrong on their street. Understand it, work out exactly who fixes it, ground it in the real city standard, get it onto the right desk, and make the person feel heard and confident it will move. Many have been frustrated for a long time; you are the outlet that finally does something.

VOICE: Warm but brief — this is mobile. Default to ONE sentence; a second only if truly needed. Cut filler and hedging; don't restate their words back at length. PLAIN LANGUAGE ONLY — a child or grandparent should understand every word; in what the resident hears, NEVER name a department, "311", or a standard/code. Where a report goes is simply "the City of <city>" (or "LA County"). If there's real feeling, acknowledge it in a few words, then act. One sharp clarifier at a time. Confident about what happens next.

GROUNDING CONTRACT (the trust core): You are given ROUTING DATA and a SOURCE CORPUS below. Use ONLY this data. Never invent a department, 311 channel, service name, or standard. The department, 311 channel, service name and standard are recorded INTERNALLY for correct filing — never name them to the resident; to them it is simply that the city will take care of it. Covered areas are exactly those in ROUTING DATA — City of LA, San Francisco, unincorporated LA County, and the listed LA County cities. If the location is outside them, say so plainly and set needsReview=true — do not pretend you can route it. If you can't confidently identify the issue or desk, ask once more or set needsReview=true. Never promise timelines; SLAs are "typical," never guaranteed.

OUTPUT CONTRACT: Respond with a SINGLE JSON object and NOTHING else (no prose, no markdown fences):
{"reply":"what Clark says now — warm, plain, 1 sentence (2 max); name where it goes only as 'the City of <city>' or 'LA County' — never a department, 311, or standard; simple enough for a grandparent","category":"Pothole|Graffiti|Trash / dumping|Broken streetlight|Blocked sidewalk|Something else|\\"\\"","jurisdiction":"exact jurisdiction from ROUTING DATA or \\"\\"","department":"exact dept from ROUTING DATA or \\"\\"","system":"exact report system from ROUTING DATA or \\"\\"","serviceName":"exact service name or \\"\\"","standards":["exact titles from SOURCE CORPUS"],"severity":"normal|priority","needsReview":true|false,"ready":true|false}
Fields category/jurisdiction/department/system/serviceName/standards must be verbatim from the data or empty — never fabricated. severity="priority" for danger/urgency cues (deep, huge, hazard, tire-popping, light out for weeks, wheelchair/elderly access, near a school). needsReview=true when out of area, ambiguous, or not confidently routable. ready=true only when category AND a covered jurisdiction are known and needsReview is false. "reply" is the only field the resident sees.`;

let _corpus = { data: "", at: 0 };
async function corpus() {
  if (_corpus.data && Date.now() - _corpus.at < 6 * 3600 * 1000) return _corpus.data;
  try {
    const [r, s] = await Promise.all([
      fetch(CORPUS_BASE + "/routing.json").then(x => x.text()),
      fetch(CORPUS_BASE + "/sources.json").then(x => x.text())
    ]);
    _corpus = { data: "\n\nROUTING DATA:\n" + r + "\n\nSOURCE CORPUS:\n" + s, at: Date.now() };
  } catch (e) { /* keep last-good; honesty rail in prompt covers gaps */ }
  return _corpus.data;
}

function parseReply(text) {
  let t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const FALLBACK = {
  reply: "I hit a snag on my end — mind sending that once more? If it keeps happening, your report still reaches the team by email.",
  category: "", jurisdiction: "", department: "", system: "", serviceName: "",
  standards: [], severity: "normal", needsReview: true, ready: false
};

async function clarkBrain(body) {
  const message = (body && body.message || "").toString().slice(0, 2000);
  if (message === "__warm__") return { reply: "", _warm: true };   // pre-warm ping — no model call
  const history = Array.isArray(body && body.history) ? body.history.slice(-12) : [];
  const userTurns = Array.isArray(body && body.history)
    ? body.history.filter(m => m && m.role === "user").length : 0;
  if (userTurns >= MAX_TURNS) {                    // per-session cap — keeps one conversation from running forever
    return { reply: "We've covered a lot in one go — let's get this one filed, or tap “Report another spot” to start fresh so I can keep it sharp.",
      category: "", jurisdiction: "", department: "", system: "", serviceName: "",
      standards: [], severity: "normal", needsReview: false, ready: false, _capped: true };
  }
  if (!message) return { ...FALLBACK, reply: "Tell me what's going on with your street and I'll take it from there." };
  const hasKey = USE_AOAI ? AOAI_KEY : API_KEY;
  if (!hasKey) return { ...FALLBACK, reply: "Clark AI isn't switched on yet — set AZURE_OPENAI_* (or ANTHROPIC_API_KEY) on the function." };
  if (dailyCeilingHit()) {                   // global daily ceiling — caps spend even under distributed abuse
    return { reply: "Clark's at capacity for today — you can still file directly at report.teaforstreets.app and it reaches the same team.",
      category: "", jurisdiction: "", department: "", system: "", serviceName: "",
      standards: [], severity: "normal", needsReview: false, ready: false, _blocked: "daily" };
  }

  const messages = history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  messages.push({ role: "user", content: message });

  // --- Azure OpenAI (GPT) — credit-covered. OpenAI chat-completions format + JSON mode. ---
  if (USE_AOAI) {
    const base = AOAI_ENDPOINT ? AOAI_ENDPOINT.replace(/\/+$/, "") : "https://" + AOAI_RES + ".openai.azure.com";
    const url = base + "/openai/deployments/" + AOAI_DEPLOY + "/chat/completions?api-version=" + AOAI_VER;
    const r = await fetch(url, {
      method: "POST",
      headers: { "api-key": AOAI_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 500,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM + (await corpus()) }, ...messages]
      })
    });
    if (!r.ok) throw new Error("azure-openai " + r.status);
    const d = await r.json();
    const txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
    const o = parseReply(txt);
    o.reply = o.reply || FALLBACK.reply;
    return o;
  }

  // --- Claude (direct Anthropic API, or Microsoft Foundry) — Messages API + prompt caching. ---
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: [{ type: "text", text: SYSTEM + (await corpus()), cache_control: { type: "ephemeral" } }],
      messages
    })
  });
  if (!res.ok) throw new Error((USE_FOUNDRY ? "foundry " : "anthropic ") + res.status);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || "").join("");
  const out = parseReply(text);
  out.reply = out.reply || FALLBACK.reply;
  return out;
}

/* ---- Azure Functions v4 wrapper (guarded so the core stays importable anywhere) ---- */
try {
  const { app } = require("@azure/functions");
  app.http("clark", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: async (request) => {
      const origin = request.headers.get("origin") || "";
      const cors = corsHeaders(origin);
      if (request.method === "OPTIONS") return { status: 204, headers: cors };
      // Casual-abuse guards (real per-IP limit lives at the edge; budget alert is the backstop).
      if (!originAllowed(origin)) {
        return { status: 403, headers: { ...cors, "content-type": "application/json" },
          jsonBody: { ...FALLBACK, reply: "This request isn't coming from Tea For Streets.", _blocked: "origin" } };
      }
      const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
      if (rateLimited(ip)) {
        return { status: 429, headers: { ...cors, "content-type": "application/json", "retry-after": "30" },
          jsonBody: { ...FALLBACK, reply: "You're sending those faster than I can file them — give it a few seconds and try again.", _blocked: "rate" } };
      }
      let body = {};
      try { body = await request.json(); } catch (e) {}
      let out;
      try { out = await clarkBrain(body); }
      catch (e) { out = { ...FALLBACK, _error: String(e && e.message || e) }; }
      return { status: 200, headers: { ...cors, "content-type": "application/json" }, jsonBody: out };
    }
  });
} catch (e) { /* not under the Azure Functions host; core is still exported below */ }

module.exports = { clarkBrain, parseReply, rateLimited, originAllowed, corsHeaders, dailyCeilingHit };
