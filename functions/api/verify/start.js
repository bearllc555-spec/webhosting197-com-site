export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

export async function onRequestPost({ request, env }) {
  try {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    return new Response(JSON.stringify({
      ok: true,
      stub: true,
      env_keys_present: {
        TWILIO_ACCOUNT_SID: !!env.TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: !!env.TWILIO_AUTH_TOKEN,
        TWILIO_VERIFY_SERVICE_SID: !!env.TWILIO_VERIFY_SERVICE_SID
      },
      sid_first4: env.TWILIO_ACCOUNT_SID ? env.TWILIO_ACCOUNT_SID.substring(0,4) : null,
      service_first4: env.TWILIO_VERIFY_SERVICE_SID ? env.TWILIO_VERIFY_SERVICE_SID.substring(0,4) : null
    }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, message: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
