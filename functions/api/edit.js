/**
 * STEP 3 DEBUG: instrument every step into a log array, return it in the
 * response so we can see exactly where execution dies.
 */

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
  const log = [];
  log.push("entered onRequestPost");

  try {
    let body;
    try {
      body = await request.json();
      log.push("parsed body, has siteJson=" + !!body.siteJson);
    } catch (err) {
      log.push("body parse threw: " + describe(err));
      return logResponse(400, log);
    }

    if (!body || !body.siteJson || typeof body.siteJson !== "object") {
      log.push("invalid body");
      return logResponse(400, log);
    }
    if (typeof body.request !== "string" || body.request.length === 0) {
      log.push("invalid request string");
      return logResponse(400, log);
    }
    log.push("validation passed");

    const provider = (env.MODEL_PROVIDER || "gemini").toLowerCase();
    log.push("provider=" + provider);

    if (!env.GEMINI_API_KEY) {
      log.push("no api key");
      return logResponse(500, log);
    }
    log.push("api key length=" + env.GEMINI_API_KEY.length);

    log.push("about to build Gemini request");
    const model = "gemini-2.5-flash";
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      env.GEMINI_API_KEY;
    log.push("url length=" + url.length);

    const reqBody = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Translate this request into a tiny JSON: {answer:'green'}. Request: " +
                body.request,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    };
    log.push("reqBody built");

    const reqBodyStr = JSON.stringify(reqBody);
    log.push("reqBody stringified, length=" + reqBodyStr.length);

    log.push("calling fetch");
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: reqBodyStr,
      });
      log.push("fetch returned status=" + r.status);
    } catch (err) {
      log.push("fetch threw: " + describe(err));
      return logResponse(502, log);
    }

    let rawText;
    try {
      rawText = await r.text();
      log.push("read text, length=" + rawText.length);
    } catch (err) {
      log.push("text() threw: " + describe(err));
      return logResponse(502, log);
    }

    log.push("first 100 chars of response: " + rawText.slice(0, 100));

    return logResponse(r.ok ? 200 : 502, log);
  } catch (err) {
    log.push("UNCAUGHT: " + describe(err));
    return logResponse(500, log);
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

function logResponse(status, log) {
  return new Response(JSON.stringify({ status, log }), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function describe(err) {
  if (!err) return String(err);
  if (typeof err === "string") return err;
  if (err.message) return (err.name || "Error") + ": " + err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
