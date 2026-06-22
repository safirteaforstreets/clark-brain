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
 *               CORS_ORIGIN (default https://report.teaforstreets.app)
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

const SYSTEM = `You are Clark — "Clark the Cup," the Tea For Streets assistant. A resident tells you, in their own words, what's wrong on their street. Understand it, work out exactly who fixes it, ground it in the real city standard, get it onto the right desk, and make the person feel heard and confident it will move. Many have been frustrated for a long time; you are the outlet that finally does something.

VOICE: Warm at the edges, operational in the middle. Action-first, never sappy. Mirror their words (reflect the specific thing back, e.g. "the crater by the school"). Acknowledge real feeling in ONE honest line, then move. One sharp clarifier at a time. Short — 1-3 sentences, mobile-first. Confident about what happens next.

GROUNDING CONTRACT (the trust core): You are given ROUTING DATA and a SOURCE CORPUS below. Use ONLY this data. Never invent a department, 311 channel, service name, or standard. Lead the standard with its meaning ("there's an official city standard for this and I'll hold them to it"), not jargon. If the location is outside the covered cities, say so plainly and set needsReview=true — do not pretend you can route it. If you can't confidently identify the issue or desk, ask once more or set needsReview=true. Never promise timelines; SLAs are "typical," never guaranteed.

OUTPUT CONTRACT: Respond with a SINGLE JSON object and NOTHING else (no prose, no markdown fences):
{"reply":"what Clark says now (warm, 1-3 sentences)","category":"Pothole|Graffiti|Trash / dumping|Broken streetlight|Blocked sidewalk|Something else|\\"\\"","jurisdiction":"Los Angeles|San Francisco|\\"\\"","department":"exact dept from ROUTING DATA or \\"\\"","system":"MyLA311|SF311|\\"\\"","serviceName":"exact service name or \\"\\"","standards":["exact titles from SOURCE CORPUS"],"severity":"normal|priority","needsReview":true|false,"ready":true|false}
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
  const history = Array.isArray(body && body.history) ? body.history.slice(-12) : [];
  if (!message) return { ...FALLBACK, reply: "Tell me what's going on with your street and I'll take it from there." };
  const hasKey = USE_AOAI ? AOAI_KEY : API_KEY;
  if (!hasKey) return { ...FALLBACK, reply: "Clark AI isn't switched on yet — set AZURE_OPENAI_* (or ANTHROPIC_API_KEY) on the function." };

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
const cors = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type"
};
try {
  const { app } = require("@azure/functions");
  app.http("clark", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: async (request) => {
      if (request.method === "OPTIONS") return { status: 204, headers: cors };
      let body = {};
      try { body = await request.json(); } catch (e) {}
      let out;
      try { out = await clarkBrain(body); }
      catch (e) { out = { ...FALLBACK, _error: String(e && e.message || e) }; }
      return { status: 200, headers: { ...cors, "content-type": "application/json" }, jsonBody: out };
    }
  });
} catch (e) { /* not under the Azure Functions host; core is still exported below */ }

module.exports = { clarkBrain, parseReply };
