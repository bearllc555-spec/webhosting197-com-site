/**
 * STEP 2 DEBUG: minimal version + Gemini call.
 * If this works, the AI call path is fine and the bug is in diff/apply.
 * If this fails, the bug is in the Gemini call itself.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  return new Response(
    JSON.stringify({
      handler: "GET",
      probe: url.searchParams.get("probe") === "1",
      hasGeminiKey: !!env.GEMINI_API_KEY,
      modelProvider: env.MODEL_PROVIDER || null,
    }),
    { status: 200, headers: jsonHeaders() }
  );
}

export async function onRequestPost({ request, env }) {
  // Top-level try/catch to surface any error inline.
  try {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return errorResponse(400, "bad json: " + describe(err));
    }

    if (!body || !body.siteJson || typeof body.siteJson !== "object") {
      return errorResponse(400, "missing siteJson");
    }
    if (typeof body.request !== "string" || body.request.length === 0) {
      return errorResponse(400, "missing request string");
    }

    const provider = (env.MODEL_PROVIDER || "gemini").toLowerCase();
    if (provider !== "gemini") {
      return errorResponse(500, "only gemini supported in this debug build");
    }
    if (!env.GEMINI_API_KEY) {
      return errorResponse(500, "GEMINI_API_KEY not configured");
    }

    // Call Gemini with a tiny system prompt + the user request.
    let geminiResult;
    try {
      geminiResult = await callGemini(env.GEMINI_API_KEY, body.request, body.siteJson);
    } catch (err) {
      return errorResponse(502, "gemini error: " + describe(err), {
        stack: err && err.stack ? String(err.stack).slice(0, 1000) : null,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        provider: "gemini",
        rawTextHead: geminiResult.rawText.slice(0, 300),
        parsedKeys: Object.keys(geminiResult.parsed || {}),
        parsed: geminiResult.parsed,
      }),
      { status: 200, headers: jsonHeaders() }
    );
  } catch (err) {
    return errorResponse(500, "uncaught: " + describe(err), {
      stack: err && err.stack ? String(err.stack).slice(0, 1000) : null,
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
      "access-control-max-age": "86400",
    },
  });
}

async function callGemini(apiKey, userRequest, siteJson) {
  const model = "gemini-2.5-flash";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    apiKey;

  const systemPrompt =
    "You translate small business owners' natural-language change requests " +
    "into a JSON diff against their site.json. " +
    "Return ONLY a JSON object: " +
    '{"narration": "<plain english>", "diff": [{"op": "set", "path": "<dot.path>", "value": <any>}], "confidence": 0.0, "warnings": []}';

  const userPrompt =
    "Current site.json: " +
    JSON.stringify(siteJson) +
    "\nRequest: " +
    userRequest;

  const reqBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  });

  const rawText = await r.text();
  if (!r.ok) {
    throw new Error("gemini http " + r.status + ": " + rawText.slice(0, 400));
  }

  let topLevel;
  try {
    topLevel = JSON.parse(rawText);
  } catch (err) {
    throw new Error("gemini returned non-JSON: " + rawText.slice(0, 200));
  }

  const text =
    topLevel &&
    topLevel.candidates &&
    topLevel.candidates[0] &&
    topLevel.candidates[0].content &&
    topLevel.candidates[0].content.parts &&
    topLevel.candidates[0].content.parts[0] &&
    topLevel.candidates[0].content.parts[0].text;

  if (!text) {
    throw new Error(
      "gemini no text. Top-level keys: " + Object.keys(topLevel).join(",")
    );
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Model returned text that isn't JSON; return null `parsed` and let the
    // raw text speak for itself.
  }

  return { rawText: text, parsed };
}

function jsonHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  };
}

function errorResponse(status, message, extra) {
  const body = { error: message };
  if (extra) {
    for (const k in extra) body[k] = extra[k];
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(),
  });
}

function describe(err) {
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return err;
  if (err && err.message) return (err.name || "Error") + ": " + err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
