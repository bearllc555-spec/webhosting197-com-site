/**
 * POST /api/edit  (DEBUG VERSION)
 *
 * Wraps the entire handler in a global try/catch and returns the actual
 * error message + stack trace in the JSON response. Once we identify the
 * underlying bug, restore the original (non-debug) edit.js from
 * editor/packages/ai-diff/.
 *
 * Also supports GET ?probe=1 which returns env-var presence + runtime
 * info without calling Gemini — useful for sanity-checking the deploy.
 */

const STANDARD_PRICE_FALLBACK = 197;

const SYSTEM_PROMPT = "You are the editor for a website builder called Press. " +
  "Translate the customer's natural-language change request into a JSON diff " +
  "against their current site.json. Return ONLY a JSON object: " +
  '{"narration":"<plain-english>","diff":[{"op":"set","path":"<dot.path>","value":<any>}],"confidence":0.0,"warnings":[]} . ' +
  "Available diff ops: set, remove, insert (with optional index), move (with from+to). " +
  "Available paths: meta, business, brand.colors.primary, brand.colors.accent, brand.voice, " +
  "services[N].name, services[N].description, sections, sections[N].type, sections[N].props.*, pages.home.sections. " +
  "For colors, return tasteful hex strings (green: #15803D, navy: #1E3A8A, etc).";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("probe") === "1") {
    return jsonOk({
      runtime: typeof navigator !== "undefined" ? "workers" : "unknown",
      hasGeminiKey: !!env.GEMINI_API_KEY,
      hasGrokKey: !!env.GROK_API_KEY,
      modelProvider: env.MODEL_PROVIDER ?? null,
      geminiModel: env.GEMINI_MODEL ?? "(default: gemini-2.5-flash)",
      hasStructuredClone: typeof structuredClone === "function",
      hasFetch: typeof fetch === "function",
      systemPromptLen: SYSTEM_PROMPT.length,
    });
  }
  return jsonError(405, "use POST or GET ?probe=1");
}

export async function onRequestPost(context) {
  // Single global try/catch: any throw goes into the response.
  try {
    return await handle(context);
  } catch (err) {
    return jsonError(500, "uncaught: " + describeError(err), {
      stack: err && err.stack ? String(err.stack).slice(0, 1500) : null,
    });
  }
}

async function handle({ request, env }) {
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
    return jsonError(400, "missing or empty request");
  }
  if (body.request.length > 2000) {
    return jsonError(400, "request too long");
  }

  const providerId = (env.MODEL_PROVIDER ?? "gemini").toLowerCase().trim();
  if (providerId !== "gemini" && providerId !== "grok") {
    return jsonError(500, "unknown MODEL_PROVIDER: " + providerId);
  }

  const userPrompt = "Current site.json:\n" +
    JSON.stringify(body.siteJson, null, 2) +
    "\n\nCustomer's request: " + body.request.trim() +
    "\n\nReturn the JSON object only.";

  // Provider call — instrumented at every step
  let raw;
  let stage = "pre-call";
  try {
    stage = "calling-provider";
    if (providerId === "gemini") {
      raw = await callGemini(env, SYSTEM_PROMPT, userPrompt);
    } else {
      raw = await callGrok(env, SYSTEM_PROMPT, userPrompt);
    }
    stage = "got-raw";
  } catch (err) {
    return jsonError(502, "provider " + providerId + " (stage=" + stage + "): " + describeError(err), {
      stack: err && err.stack ? String(err.stack).slice(0, 1500) : null,
    });
  }

  let parsed;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonError(502, "parse: " + describeError(err), { rawHead: raw.slice(0, 400) });
  }

  if (typeof parsed.narration !== "string" || !Array.isArray(parsed.diff) || typeof parsed.confidence !== "number") {
    return jsonError(502, "model returned malformed shape", { received: parsed });
  }
  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  let proposedSite = body.siteJson;
  let validated = true;
  let validationError = null;
  try {
    proposedSite = applyDiff(body.siteJson, parsed.diff);
  } catch (err) {
    validated = false;
    validationError = "apply: " + describeError(err);
  }

  return jsonOk({
    narration: parsed.narration,
    diff: parsed.diff,
    confidence: parsed.confidence,
    warnings: parsed.warnings,
    proposedSite,
    validated,
    validationError,
    provider: providerId,
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

/* ---------- providers ---------- */

async function callGemini(env, systemPrompt, userPrompt) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    model + ":generateContent?key=" + env.GEMINI_API_KEY;
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
  const text = await r.text();
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + text.slice(0, 300));
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("Gemini returned non-JSON: " + text.slice(0, 200)); }
  const out = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
  if (!out) throw new Error("Gemini returned no text. Top-level keys: " + Object.keys(j).join(","));
  return out;
}

async function callGrok(env, systemPrompt, userPrompt) {
  if (!env.GROK_API_KEY) throw new Error("GROK_API_KEY not configured");
  const model = env.GROK_MODEL || "grok-4-fast";
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + env.GROK_API_KEY,
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
  const text = await r.text();
  if (!r.ok) throw new Error("Grok " + r.status + ": " + text.slice(0, 300));
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("Grok returned non-JSON: " + text.slice(0, 200)); }
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error("Grok returned no text. Top-level keys: " + Object.keys(j).join(","));
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
      if (!Array.isArray(parent)) throw new Error("move from non-array path " + op.from);
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
      if (cur === null || typeof cur !== "object") throw new Error("walk into non-object at " + t.value);
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
  if (!Array.isArray(target)) throw new Error("insert into non-array at " + path);
  if (index === undefined) target.push(value);
  else target.splice(Math.max(0, Math.min(index, target.length)), 0, value);
}

/* ---------- helpers ---------- */

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function jsonError(status, message, extra) {
  const body = { error: message };
  if (extra) for (const k of Object.keys(extra)) body[k] = extra[k];
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function describeError(err) {
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    return (err.name || "Error") + ": " + (err.message || "(no message)");
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}
