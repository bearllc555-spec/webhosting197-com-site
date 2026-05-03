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

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('origin') || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  let phase = 'init';
  try {
    phase = 'parse_body';
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_body' }), { status: 400, headers });
    }

    phase = 'validate_email';
    const email = ((body && body.email) || '').toString().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_email' }), { status: 400, headers });
    }

    phase = 'check_env';
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
    if (!accountSid || !authToken || !serviceSid) {
      return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers });
    }

    phase = 'build_request';
    const twilioUrl = 'https://verify.twilio.com/v2/Services/' + serviceSid + '/Verifications';
    const auth = btoa(accountSid + ':' + authToken);
    const formBody = 'To=' + encodeURIComponent(email) + '&Channel=email';

    phase = 'twilio_fetch';
    const res = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: formBody
    });

    phase = 'twilio_read';
    const text = await res.text();
    let j = {};
    try { j = JSON.parse(text); } catch {}

    phase = 'twilio_handle';
    if (!res.ok) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'twilio_error',
        twilio_status: res.status,
        twilio_code: j.code || null,
        twilio_message: (j.message || '').substring(0, 200),
        twilio_more_info: j.more_info || null
      }), { status: 502, headers });
    }

    return new Response(JSON.stringify({ ok: true, status: j.status || 'pending' }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'unhandled',
      phase: phase,
      message: String(err && err.message || err).substring(0, 300),
      name: String(err && err.name || 'Error')
    }), { status: 500, headers });
  }
}
