// POST /api/verify/check
// Body: { email, code }
// Validates the 6-digit code via Twilio Verify Check.

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

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_body' }), { status: 400, headers });
  }

  const email = (body && body.email || '').trim();
  const code = (body && body.code || '').toString().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_email' }), { status: 400, headers });
  }
  if (!/^\d{4,8}$/.test(code)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 400, headers });
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
  if (!accountSid || !authToken || !serviceSid) {
    return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers });
  }

  const twilioUrl = `https://verify.twilio.com/v2/Services/${serviceSid}/VerificationCheck`;
  const auth = btoa(`${accountSid}:${authToken}`);
  const params = new URLSearchParams();
  params.append('To', email);
  params.append('Code', code);

  const res = await fetch(twilioUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const j = await res.json().catch(() => ({}));

  if (res.status === 404) {
    return new Response(JSON.stringify({ ok: false, error: 'expired_or_not_found' }), { status: 400, headers });
  }
  if (!res.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'twilio_error', detail: j.message || j.code || 'unknown', status: res.status }), { status: 502, headers });
  }
  if (j.status !== 'approved') {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 400, headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
