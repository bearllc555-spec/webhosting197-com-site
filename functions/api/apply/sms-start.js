// POST /api/apply/sms-start
// Body: { firstName, lastName, phone, email }
// 1) Validate input shape
// 2) Send SMS code via Twilio Verify Service
// 3) Set HMAC-signed cookie carrying { phoneHash, emailHash, exp }
// 4) Return ok
//
// Cookie: vh_apply (HttpOnly Secure SameSite=Strict, Path=/api/apply, 10 min)
// Format: phoneHash.emailHash.exp.sig

const ALLOWED_ORIGINS = new Set([
  'https://webhosting197.com',
  'https://www.webhosting197.com',
  'https://webhosting197-com.pages.dev'
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://webhosting197.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return bytesToHex(buf);
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToHex(sig);
}

// US-default phone normalization. Strip non-digits; assume US country code if 10 digits.
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return null;
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin') || '') });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin') || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  try {
    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_body' }), { status: 400, headers });
    }

    const firstName = ((body && body.firstName) || '').toString().trim();
    const lastName = ((body && body.lastName) || '').toString().trim();
    const email = ((body && body.email) || '').toString().trim().toLowerCase();
    const phone = normalizePhone(body && body.phone);

    if (!firstName || !lastName) {
      return new Response(JSON.stringify({ ok: false, error: 'missing_name', message: 'Please enter your name.' }), { status: 400, headers });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_email', message: 'Please enter a valid email.' }), { status: 400, headers });
    }
    if (!phone) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_phone', message: 'Please enter a valid US phone number.' }), { status: 400, headers });
    }

    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
    const secret = env.VERIFY_SIGNING_SECRET;

    if (!accountSid || !authToken || !serviceSid || !secret) {
      return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers });
    }

    // Send SMS via Twilio Verify Service
    const auth = btoa(accountSid + ':' + authToken);
    const twilioResp = await fetch(
      'https://verify.twilio.com/v2/Services/' + serviceSid + '/Verifications',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ 'To': phone, 'Channel': 'sms' }).toString(),
      }
    );

    if (!twilioResp.ok) {
      const errText = await twilioResp.text();
      let errCode = 'sms_failed';
      let errMsg = 'Could not send verification code. Try again in a moment.';
      try {
        const errJson = JSON.parse(errText);
        if (errJson.code === 60200) { errCode = 'invalid_phone'; errMsg = 'That phone number is not valid for SMS.'; }
        else if (errJson.code === 60410) { errCode = 'too_many_attempts'; errMsg = 'Too many recent attempts. Try again in 10 minutes.'; }
        else if (errJson.code === 60203) { errCode = 'max_attempts'; errMsg = 'Verification limit reached for this number. Try again later.'; }
        else if (errJson.code === 21408 || errJson.code === 21211) { errCode = 'unverified_caller_trial'; errMsg = 'This phone number is not yet authorized to receive SMS during our private beta. Please contact us to get whitelisted.'; }
      } catch {}
      return new Response(JSON.stringify({ ok: false, error: errCode, message: errMsg }), { status: 400, headers });
    }

    // Set HMAC-signed cookie tracking pending verification
    const exp = Date.now() + 10 * 60 * 1000; // 10 min
    const phoneHash = await sha256Hex(phone);
    const emailHash = await sha256Hex(email);
    const payload = phoneHash + '.' + emailHash + '.' + exp;
    const sig = await hmacHex(secret, payload);
    const cookieValue = payload + '.' + sig;

    headers['Set-Cookie'] = 'vh_apply=' + cookieValue + '; HttpOnly; Secure; SameSite=Strict; Path=/api/apply; Max-Age=600';

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'server_error', message: e.message || String(e) }), { status: 500, headers });
  }
}
