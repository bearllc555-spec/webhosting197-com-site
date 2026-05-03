const ALLOWED_ORIGINS = new Set([
  'https://webhosting197.com',
  'https://www.webhosting197.com',
  'https://webhosting197-com.pages.dev'
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://webhosting197.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin') || '') });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin') || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_body' }), { status: 400, headers });
    }

    const email = ((body && body.email) || '').toString().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_email' }), { status: 400, headers });
    }

    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
    if (!accountSid || !authToken || !serviceSid) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'server_misconfigured',
        debug: {
          has_account_sid: !!accountSid,
          has_auth_token: !!authToken,
          has_service_sid: !!serviceSid
        }
      }), { status: 500, headers });
    }

    const twilioUrl = 'https://verify.twilio.com/v2/Services/' + serviceSid + '/Verifications';
    const auth = btoa(accountSid + ':' + authToken);
    const params = new URLSearchParams();
    params.append('To', email);
    params.append('Channel', 'email');

    const res = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const text = await res.text();
    let j = {};
    try { j = JSON.parse(text); } catch {}

    if (!res.ok) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'twilio_error',
        status: res.status,
        twilio_message: j.message || j.code || text.substring(0, 200)
      }), { status: 502, headers });
    }

    return new Response(JSON.stringify({ ok: true, status: j.status || 'pending' }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'unhandled', message: String(err && err.message || err), stack: String(err && err.stack || '').substring(0, 500) }), { status: 500, headers });
  }
}
