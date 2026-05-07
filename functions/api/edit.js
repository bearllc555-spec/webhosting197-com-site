/**
 * STEP 6: POST + body to httpbin instead of Gemini.
 * Determines if the bug is Gemini-specific or about POST-with-body in general.
 */

export async function onRequestGet({ request, env }) {
  return new Response(
    JSON.stringify({ handler: "GET", hasGeminiKey: !!env.GEMINI_API_KEY }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

export async function onRequestPost({ request, env }) {
  const log = [];
  log.push("entered POST");
  try {
    const body = await request.json().catch(() => ({}));
    log.push("parsed body");

    log.push("test 1: POST httpbin/post with body");
    try {
      const r = await fetch("https://httpbin.org/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world", request: body.request || "test" }),
      });
      const t = await r.text();
      log.push("httpbin POST status=" + r.status + " text len=" + t.length);
    } catch (err) {
      log.push("httpbin POST threw: " + describe(err));
    }

    log.push("test 2: POST gemini with header auth + minimal body");
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY || "",
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Say green" }] }],
          }),
        }
      );
      const t = await r.text();
      log.push("gemini POST status=" + r.status + " text len=" + t.length);
      log.push("gemini text first 100: " + t.slice(0, 100));
    } catch (err) {
      log.push("gemini POST threw: " + describe(err));
    }

    return jsonResp(200, { log });
  } catch (err) {
    log.push("UNCAUGHT: " + describe(err));
    return jsonResp(500, { log });
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
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function describe(err) {
  if (!err) return String(err);
  if (typeof err === "string") return err;
  if (err.message) return (err.name || "Error") + ": " + err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}
