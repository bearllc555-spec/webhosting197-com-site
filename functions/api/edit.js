/**
 * POST /api/edit  (production)
 *
 * Customer types "make the hero green" → this endpoint translates the request
 * into a validated JSON diff against their current site.json and returns the
 * proposed change for preview. The customer-facing chat UI calls this and
 * renders the diff for the customer to approve before /api/apply persists it.
 *
 * Key implementation note: API key is sent via the x-goog-api-key header,
 * NOT in the URL query string. Putting the key in the URL caused error
 * messages (with that URL embedded) to trip Cloudflare's secret-leak
 * protection, returning generic 502 HTML instead of our JSON errors.
 */

const SYSTEM_PROMPT =
  "You are the editor for a website builder called Press. A small business " +
  "owner is describing a change they want made to their website. Translate " +
  "their request into a JSON diff against their current site.json.\n\n" +
  "Schema: site.json has these top-level keys: meta, business, brand " +
  "(with brand.colors.primary etc), services (array), sections (array), pages.\n" +
  "Each section has type and props. Section types: hero, services_grid, " +
  "gallery, testimonials, cta, form, town_intros.\n\n" +
  "Return ONLY a JSON object matching this shape:\n" +
  '{"narration": "<plain english, ≤2 sentences, friendly>", ' +
  '"diff": [{"op": "set|remove|insert|move", "path": "<dot.path>", "value": <any>, "index": <number?>, "from": "<path?>", "to": "<path?>"}], ' +
  '"confidence": 0.0 to 1.0, "warnings": []}\n\n' +
  "Path syntax: dot-separated, array indices as [N]. Examples: " +
  '"brand.colors.primary", "sections[2].props.headline", "services[0].name".\n\n' +
  "For colors, choose tasteful hex (green=#15803D, navy=#1E3A8A, " +
  "terra=#C2410C, rose=#BE123C, slate=#475569).\n\n" +
  "If ambiguous, set confidence ≤0.6 and add a warning. " +
  "If impossible, return diff=[] with explanation in narration.";

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (err) {
    return jsonResp(500, {
      error: "uncaught",
      message: err && err.message ? err.message : String(err),
    });
  }
}

async function handle({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp(400, { error: "invalid JSON body" });
  }
  if (!body || !body.siteJson || typeof body.siteJson !== "object") {
    return jsonResp(400, { error: "missing or invalid siteJson" });
  }
  if (typeof body.request !== "string" || body.request.trim().length === 0) {
    return jsonResp(400, { error: "missing or empty request" });
  }
  if (body.request.length > 2000) {
    return jsonResp(400, { error: "request too long (max 2000 chars)" });
  }
  if (!env.GEMINI_API_KEY) {
    return jsonResp(500, { error: "GEMINI_API_KEY not configured" });
  }

  const userPrompt =
    "Current site.json:\n```json\n" +
    JSON.stringify(body.siteJson, null, 2) +
    "\n```\n\nCustomer's request: " +
    body.request.trim() +
    "\n\nRespond with the JSON object only.";

  let geminiText;
  try {
    geminiText = await callGemini(env.GEMINI_API_KEY, SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    return jsonResp(502, {
      error: "gemini call failed",
      message: err && err.message ? err.message : String(err),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(geminiText);
  } catch {
    return jsonResp(502, {
      error: "model output not JSON",
      modelText: geminiText.slice(0, 400),
    });
  }

  if (
    typeof parsed.narration !== "string" ||
    !Array.isArray(parsed.diff) ||
    typeof parsed.confidence !== "number"
  ) {
    return jsonResp(502, {
      error: "model output malformed",
      received: parsed,
    });
  }
  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  let proposedSite = body.siteJson;
  let validated = true;
  let validationError = null;
  try {
    proposedSite = applyDiff(body.siteJson, parsed.diff);
  } catch (err) {
    validated = false;
    validationError = err && err.message ? err.message : String(err);
  }

  return jsonResp(200, {
    narration: parsed.narration,
    diff: parsed.diff,
    confidence: parsed.confidence,
    warnings: parsed.warnings,
    proposedSite,
    validated,
    validationError,
    provider: "gemini",
  });
}

export async function onRequestGet({ env }) {
  return jsonResp(200, {
    handler: "GET",
    hasGeminiKey: !!env.GEMINI_API_KEY,
    modelProvider: env.MODEL_PROVIDER || "gemini",
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

/* ---------- Gemini call (header auth) ---------- */

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error("gemini http " + r.status + ": " + text.slice(0, 300));
  }

  let topLevel;
  try {
    topLevel = JSON.parse(text);
  } catch {
    throw new Error("gemini returned non-JSON");
  }

  const out =
    topLevel?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) {
    throw new Error("gemini returned no text");
  }
  return out;
}

/* ---------- diff applier ---------- */

function applyDiff(input, diff) {
  const out = JSON.parse(JSON.stringify(input));
  for (const op of diff) applyOp(out, op);
  return out;
}

function applyOp(root, op) {
  if (op.op === "set") return setAtPath(root, op.path, op.value);
  if (op.op === "remove") return removeAtPath(root, op.path);
  if (op.op === "insert") return insertAtPath(root, op.path, op.value, op.index);
  if (op.op === "move") {
    const tokens = tokenize(op.from);
    const parent = walkToParent(root, tokens);
    const last = tokens[tokens.length - 1];
    let value;
    if (last.kind === "key") {
      value = parent[last.value];
      delete parent[last.value];
    } else {
      if (!Array.isArray(parent)) throw new Error("move from non-array");
      value = parent[last.value];
      parent.splice(last.value, 1);
    }
    return setAtPath(root, op.to, value);
  }
  throw new Error("unknown op: " + op.op);
}

function tokenize(path) {
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) tokens.push({ kind: "key", value: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "index", value: parseInt(m[2], 10) });
  }
  return tokens;
}

function walkTo(root, tokens) {
  let cur = root;
  for (const t of tokens) {
    if (t.kind === "key") {
      if (cur === null || typeof cur !== "object") throw new Error("walk into non-object");
      cur = cur[t.value];
    } else {
      if (!Array.isArray(cur)) throw new Error("index access on non-array");
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
  if (!Array.isArray(target)) throw new Error("insert into non-array");
  if (index === undefined) target.push(value);
  else target.splice(Math.max(0, Math.min(index, target.length)), 0, value);
}

/* ---------- helpers ---------- */

function jsonResp(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
