/**
 * POST /api/edit
 *
 * The Press editor's brain. Customer types "make the hero green"; this
 * endpoint translates the request into a validated JSON diff against
 * their current site.json and returns the proposed change.
 *
 * Request:
 *   { siteJson: <Site>, request: "make the hero green" }
 *
 * Response:
 *   {
 *     narration:    "Switching brand color to a forester green.",
 *     diff:         [{ op: "set", path: "brand.colors.primary", value: "#15803D" }],
 *     confidence:   0.92,
 *     warnings:     [],
 *     proposedSite: <Site after applying the diff>,
 *     validated:    true,
 *     provider:     "gemini"
 *   }
 *
 * The customer-facing chat UI calls this and renders the proposed change
 * for preview before the customer clicks "Apply" (which goes to /api/apply
 * to actually persist + redeploy — separate endpoint, separate concern).
 *
 * Provider selection: env.MODEL_PROVIDER ("gemini" or "grok"). Defaults to
 * gemini. Whichever is selected, the corresponding API key env var must be
 * set: GEMINI_API_KEY or GROK_API_KEY.
 *
 * Implementation note: this Function inlines the schema + diff-apply logic
 * rather than depending on @press/ai-diff at runtime, because Cloudflare
 * Pages Functions don't have a workspace-package resolver. The duplication
 * is small (~200 lines) and worth it for a clean deploy story. Keep the
 * two copies in sync: any change in editor/packages/ai-diff/src/ should
 * be mirrored here.
 */

const STANDARD_PRICE_FALLBACK = 197;
const STRIPE_API_VERSION_NOTE = "n/a — this endpoint doesn't talk to Stripe";

const SYSTEM_PROMPT = `You are the editor for a website builder called Press. A small business owner is describing a change they want made to their website. Your job is to translate that request into a structured JSON diff against their current site.json.

## What you can change

The site.json conforms to a fixed schema:

\`\`\`
Site {
  meta:     { customer_slug, template, hero_variant, schema_version }
  business: { name, tagline?, industry, year_established?, contact: {...}, service_area: [...] }
  brand:    { logo_url?, colors: { primary, accent?, neutral_dark?, neutral_light? }, voice }
  services: [ { name, description, image_url? } ]
  sections: [ <section, see below> ]
  pages:    { home: { sections: [ index, ... ] } }
}
\`\`\`

Sections is an ordered array. Each section has a discriminator \`type\` and a \`props\` object:

- **hero**: { headline, subheadline?, cta_label?, cta_href?, background_image_url? }
- **services_grid**: { heading?, service_indices?: number[], layout?: "grid-2" | "grid-3" | "grid-4" }
- **gallery**: { heading?, image_urls: string[], layout?: "masonry" | "carousel" | "grid" }
- **testimonials**: { heading?, testimonials: [ { quote, author, role?, avatar_url? } ] }
- **cta**: { heading, subheading?, cta_label, cta_href }
- **form**: { heading?, fields: [...], submit_label?, destination_email }
- **town_intros**: { heading?, videos: [ { town, state, video_url, thumbnail_url? } ] }

\`pages.home.sections\` controls which sections appear on the home page (by index into the sections array).

## How to return your answer

Return a JSON object — and ONLY a JSON object — matching this shape:

\`\`\`
{
  "narration": "Plain-English description of what you'll change. ≤ 2 sentences. Friendly tone.",
  "diff": [
    { "op": "set",    "path": "<dot.path>", "value": <any> },
    { "op": "remove", "path": "<dot.path>" },
    { "op": "insert", "path": "<dot.path>", "index": <number?>, "value": <any> },
    { "op": "move",   "from": "<dot.path>", "to": "<dot.path>" }
  ],
  "confidence": 0.0 to 1.0,
  "warnings": [ "Optional. List anything the customer should review before applying." ]
}
\`\`\`

Path syntax: dot-separated. Array indices are written as \`[N]\` — e.g., \`sections[2].props.headline\`. Use \`set\` for any value replacement (including nested objects). Use \`insert\` to add a new section or service. Use \`remove\` to delete. Use \`move\` to reorder sections.

## Rules

- Output ONLY the JSON object. No markdown fences, no commentary.
- Stay strictly inside the schema. If the customer asks for something outside it, insert the appropriate section AND update \`pages.home.sections\` to include it.
- Keep diffs minimal — change only what was asked for. Do not "improve" copy the customer didn't ask you to touch.
- If the customer says "make it green" or "blue" or any color, choose a tasteful hex value (e.g., green → #15803D, navy → #1E3A8A, terra → #C2410C) and set \`brand.colors.primary\`.
- If the request is ambiguous, set \`confidence\` low (≤ 0.6) and add an entry to \`warnings\` explaining what assumption you made.
- If the request is impossible inside the schema, return: \`{ "narration": "...explanation...", "diff": [], "confidence": 0, "warnings": ["unsupported"] }\`.
- Never invent customer data. If the customer asks for something that requires data we don't have, ask in narration rather than guess.

## Examples

Request: "make the hero green"
Response: { "narration": "Switching your brand color to a forester green so it reads naturally on light backgrounds.", "diff": [{ "op": "set", "path": "brand.colors.primary", "value": "#15803D" }], "confidence": 0.9, "warnings": [] }

Request: "show services in a 4-column grid"
Response: { "narration": "Switching your services grid from 2-up to 4-up.", "diff": [{ "op": "set", "path": "sections[1].props.layout", "value": "grid-4" }], "confidence": 0.95, "warnings": [] }

Now translate the next customer request.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  // Parse + validate request
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "request body must be valid JSON");
  }
  if (!body.siteJson || typeof body.siteJson !== "object") {
    return jsonError(400, "missing or invalid siteJson");
  }
  if (typeof body.request !== "string" || body.request.trim().length === 0) {
    return jsonError(400, "missing or empty request string");
  }
  if (body.request.length > 2000) {
    return jsonError(400, "request too long (max 2000 chars)");
  }

  // Resolve provider
  const providerId = (env.MODEL_PROVIDER ?? "gemini").toLowerCase().trim();
  if (providerId !== "gemini" && providerId !== "grok") {
    return jsonError(500, `unknown MODEL_PROVIDER: ${providerId}`);
  }

  // Build prompt
  const userPrompt = [
    "## Current site.json",
    "",
    "```json",
    JSON.stringify(body.siteJson, null, 2),
    "```",
    "",
    "## Customer's request",
    "",
    body.request.trim(),
    "",
    "Respond with the JSON object only.",
  ].join("\n");

  // Call provider
  let raw;
  try {
    raw =
      providerId === "gemini"
        ? await callGemini(env, SYSTEM_PROMPT, userPrompt)
        : await callGrok(env, SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    return jsonError(502, `provider ${providerId}: ${err.message ?? err}`);
  }

  // Parse model output
  let parsed;
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonError(502, `model returned non-JSON: ${err.message}`, {
      raw: raw.slice(0, 500),
    });
  }

  // Validate response shape
  if (
    typeof parsed.narration !== "string" ||
    !Array.isArray(parsed.diff) ||
    typeof parsed.confidence !== "number"
  ) {
    return jsonError(502, "model returned malformed response shape", {
      received: parsed,
    });
  }
  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  // Apply diff to a clone, see if it produces a valid-shaped site
  let proposedSite = body.siteJson;
  let validated = true;
  let validationError = null;
  try {
    proposedSite = applyDiff(body.siteJson, parsed.diff);
  } catch (err) {
    validated = false;
    validationError = `apply error: ${err.message}`;
  }

  return new Response(
    JSON.stringify({
      narration: parsed.narration,
      diff: parsed.diff,
      confidence: parsed.confidence,
      warnings: parsed.warnings,
      proposedSite,
      validated,
      validationError,
      provider: providerId,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      },
    }
  );
}

// CORS preflight (for Press chat UI calling from a different subdomain)
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

/* ---------- provider adapters ---------- */

async function callGemini(env, systemPrompt, userPrompt) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }
  const model = env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Gemini ${r.status}: ${j.error?.message ?? "unknown"}`);
  }
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

async function callGrok(env, systemPrompt, userPrompt) {
  if (!env.GROK_API_KEY) {
    throw new Error("GROK_API_KEY not configured");
  }
  const model = env.GROK_MODEL ?? "grok-4-fast";
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: "json_object" },
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Grok ${r.status}: ${j.error?.message ?? "unknown"}`);
  }
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error("Grok returned no text");
  return text;
}

/* ---------- diff applier (mirror of @press/ai-diff/apply.ts) ---------- */

function applyDiff(input, diff) {
  const out = structuredClone(input);
  for (const op of diff) applyOp(out, op);
  return out;
}

function applyOp(root, op) {
  switch (op.op) {
    case "set":
      setAtPath(root, op.path, op.value);
      return;
    case "remove":
      removeAtPath(root, op.path);
      return;
    case "insert":
      insertAtPath(root, op.path, op.value, op.index);
      return;
    case "move": {
      const tokens = tokenize(op.from);
      const parent = walkToParent(root, tokens);
      const last = tokens[tokens.length - 1];
      let value;
      if (last.kind === "key") {
        value = parent[last.value];
        delete parent[last.value];
      } else {
        if (!Array.isArray(parent)) {
          throw new Error(`move from non-array path ${op.from}`);
        }
        value = parent[last.value];
        parent.splice(last.value, 1);
      }
      setAtPath(root, op.to, value);
      return;
    }
    default:
      throw new Error(`unknown op: ${op.op}`);
  }
}

function tokenize(path) {
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) tokens.push({ kind: "key", value: m[1] });
    else if (m[2] !== undefined)
      tokens.push({ kind: "index", value: parseInt(m[2], 10) });
  }
  return tokens;
}

function walkTo(root, tokens) {
  let cur = root;
  for (const t of tokens) {
    if (t.kind === "key") {
      if (cur === null || typeof cur !== "object") {
        throw new Error(`cannot walk into non-object at ${t.value}`);
      }
      cur = cur[t.value];
    } else {
      if (!Array.isArray(cur)) {
        throw new Error(`index access on non-array`);
      }
      cur = cur[t.value];
    }
  }
  return cur;
}

function walkToParent(root, tokens) {
  return walkTo(root, tokens.slice(0, -1));
}

function setAtPath(root, path, value) {
  const tokens = tokenize(path);
  if (tokens.length === 0) throw new Error("empty path");
  const last = tokens[tokens.length - 1];
  const parent = walkToParent(root, tokens);
  if (last.kind === "key") parent[last.value] = value;
  else parent[last.value] = value;
}

function removeAtPath(root, path) {
  const tokens = tokenize(path);
  if (tokens.length === 0) throw new Error("empty path");
  const last = tokens[tokens.length - 1];
  const parent = walkToParent(root, tokens);
  if (last.kind === "key") delete parent[last.value];
  else parent.splice(last.value, 1);
}

function insertAtPath(root, path, value, index) {
  const tokens = tokenize(path);
  const target = walkTo(root, tokens);
  if (!Array.isArray(target)) {
    throw new Error(`insert into non-array at ${path}`);
  }
  if (index === undefined) target.push(value);
  else target.splice(Math.max(0, Math.min(index, target.length)), 0, value);
}

/* ---------- helpers ---------- */

function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
