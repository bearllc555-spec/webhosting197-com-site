/**
 * MINIMAL DEBUG: just returns hardcoded JSON. No Gemini call, no schema,
 * no diff logic. Used to bisect what's causing 502 on the previous version.
 * If THIS works, the bug is in the AI/diff code (which we add back next).
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
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      },
    }
  );
}

export async function onRequestPost({ request, env }) {
  let body = null;
  let bodyError = null;
  try {
    body = await request.json();
  } catch (err) {
    bodyError = err && err.message ? err.message : String(err);
  }

  return new Response(
    JSON.stringify({
      handler: "POST",
      receivedBody: body,
      bodyError,
      hasGeminiKey: !!env.GEMINI_API_KEY,
      modelProvider: env.MODEL_PROVIDER || null,
      hardcoded: {
        narration: "This is a hardcoded response. AI is not actually being called.",
        diff: [{ op: "set", path: "brand.colors.primary", value: "#15803D" }],
        confidence: 1.0,
        warnings: [],
      },
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
