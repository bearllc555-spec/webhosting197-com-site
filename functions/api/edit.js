/**
 * STEP 4 DEBUG: instead of calling Gemini, call a known-good URL (httpbin)
 * to determine if the issue is specifically with Gemini's endpoint or
 * with fetching from CF Pages in general.
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
  log.push("entered POST");

  try {
    const body = await request.json().catch(() => null);
    log.push("body: " + (body ? "ok" : "null"));

    if (!body || !body.siteJson) {
      log.push("missing siteJson");
      return logResp(400, log);
    }
    log.push("validation passed");

    log.push("about to fetch Google generativelanguage");
    let r1, t1;
    try {
      r1 = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?key=NOTAKEY",
        { method: "GET" }
      );
      log.push("googleapis status=" + r1.status);
      t1 = await r1.text();
      log.push("googleapis text len=" + t1.length);
    } catch (err) {
      log.push("googleapis fetch threw: " + describe(err));
    }

    log.push("about to fetch httpbin");
    let r2, t2;
    try {
      r2 = await fetch("https://httpbin.org/get", { method: "GET" });
      log.push("httpbin status=" + r2.status);
      t2 = await r2.text();
      log.push("httpbin text len=" + t2.length);
    } catch (err) {
      log.push("httpbin fetch threw: " + describe(err));
    }

    log.push("about to fetch api.stripe.com");
    let r3, t3;
    try {
      r3 = await fetch("https://api.stripe.com/v1/charges", { method: "GET" });
      log.push("stripe status=" + r3.status);
      t3 = await r3.text();
      log.push("stripe text len=" + t3.length);
    } catch (err) {
      log.push("stripe fetch threw: " + describe(err));
    }

    return logResp(200, log);
  } catch (err) {
    log.push("UNCAUGHT: " + describe(err));
    return logResp(500, log);
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

function logResp(status, log) {
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
