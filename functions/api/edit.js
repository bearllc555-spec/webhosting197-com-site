/**
 * STEP 5: full edit endpoint with HEADER auth (not URL query string).
 * Theory: previous version's URL contained the API key, which appeared in
 * error stack traces, which Cloudflare's secret-detection blocked at the
 * response layer (returning generic 502 HTML). Header auth keeps the key
 * out of any string we might end up returning.
 */

const SYSTEM_PROMPT =
  "You translate small business owners' natural-language change requests " +
  "into a JSON diff against their site.json. Return ONLY a JSON object: " +
  '{"narration": "<plain english, friendly tone, max 2 sentences>", ' +
  '"diff": [{"op": "set|remove|insert|move", "path": "<dot.path>", "value": <any>}], ' +
  '"confidence": 0.0, "warnings": []}. ' +
  "For colors, use tasteful hex (green=#15803D, navy=#1E3A8A, terra=#C2410C). " +
  "For section layout changes, paths look like sections[N].props.layout.";

export async function onRequestGet({ request, env }) {
  return new Response(
    JSON.stringify({
      handler: "GET",
      hasGeminiKey: !!env.GEMINI_API_KEY,
      modelProvider: env.MODEL_PROVIDER || null,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

export async function onRequestPost({ request, env }) {
  try {
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
      return jsonResp(400, { error: "request too long" });
    }
    if (!env.GEMINI_API_KEY) {
      return jsonResp(500, { error: "GEMINI_API_KEY not configured" });
    }

    const userPrompt =
      "Current site.json: " +
      JSON.stringify(body.siteJson) +
      "\n\nRequest: " +
      body.request.trim();

    const reqBody = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    };

    // Header auth — keeps the API key out of the URL (which would otherwise
    // appear in error stack traces and trip CF's secret-leak protection).
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    let geminiResp;
    try {
      geminiResp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify(reqBody),
      });
    } catch (err) {
      return jsonResp(502, {
        error: "gemini fetch failed",
        message: err && err.message ? err.message : String(err),
      });
    }

    const text = await geminiResp.text();
    if (!geminiResp.ok) {
      return jsonResp(502, {
        error: "gemini http " + geminiResp.status,
        body: text.slice(0, 500),
      });
    }

    let topLevel;
    try {
      topLevel = JSON.parse(text);
    } catch {
      return jsonResp(502, {
        error: "gemini returned non-JSON",
        body: text.slice(0, 500),
      });
    }

    const modelText =
      topLevel?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!modelText) {
      return jsonResp(502, {
        error: "gemini no model text",
        topLevelKeys: Object.keys(topLevel),
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(modelText);
    } catch {
      return jsonResp(502, {
        error: "model output not JSON",
        modelText: modelText.slice(0, 400),
      });
    }

    if (
      typeof parsed.narration !== "string" ||
      !Array.isArray(parsed.diff) ||
      typeof parsed.confidence !== "number"
    ) {
      return jsonResp(502, {
        error: "model output malformed shape",
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
  } catch (err) {
    return jsonResp(500, {
      error: "uncaught",
      message: err && err.message ? err.message : String(err),
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function jsonResp(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

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
