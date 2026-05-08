// POST /api/apply/sms-check
// Body: { phone, code }
// 1) Read vh_apply cookie, verify HMAC, ensure phoneHash matches submitted phone
// 2) Call Twilio Verify VerificationCheck with To=phone Code=code
// 3) On approved, return { ok: true, verifiedToken }
//    The verifiedToken is an HMAC-signed payload the client passes to the
//    Formspree submit step to prove identity verification happened. Token
//    contains phoneHash + emailHash + verifiedAt + 60-min exp.

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

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return null;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
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

    const phone = normalizePhone(body && body.phone);
    const code = ((body && body.code) || '').toString().trim();
    if (!phone) return new Response(JSON.stringify({ ok: false, error: 'invalid_phone' }), { status: 400, headers });
    if (!/^\d{4,10}$/.test(code)) return new Response(JSON.stringify({ ok: false, error: 'invalid_code', message: 'Enter the code we sent.' }), { status: 400, headers });

    // Read + verify cookie
    const cookieHeader = request.headers.get('cookie') || '';
    const raw = parseCookie(cookieHeader, 'vh_apply');
    if (!raw) return new Response(JSON.stringify({ ok: false, error: 'no_pending_verification', message: 'Send a code first.' }), { status: 400, headers });

    const parts = raw.split('.');
    if (parts.length !== 4) return new Response(JSON.stringify({ ok: false, error: 'malformed_cookie' }), { status: 400, headers });
    const [phoneHashCookie, emailHashCookie, expStr, sig] = parts;

    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() > exp) return new Response(JSON.stringify({ ok: false, error: 'expired', message: 'Code expired. Send a new one.' }), { status: 400, headers });

    const secret = env.VERIFY_SIGNING_SECRET;
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
    if (!secret || !accountSid || !authToken || !serviceSid) {
      return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers });
    }

    const expectedSig = await hmacHex(secret, phoneHashCookie + '.' + emailHashCookie + '.' + expStr);
    if (!constantTimeEqual(sig, expectedSig)) {
      return new Response(JSON.stringify({ ok: false, error: 'tampered' }), { status: 400, headers });
    }

    const phoneHashSubmitted = await sha256Hex(phone);
    if (!constantTimeEqual(phoneHashCookie, phoneHashSubmitted)) {
      return new Response(JSON.stringify({ ok: false, error: 'phone_mismatch', message: 'Phone number does not match the one we sent the code to.' }), { status: 400, headers });
    }

    // Call Twilio VerificationCheck
    const auth = btoa(accountSid + ':' + authToken);
    const twilioResp = await fetch(
      'https://verify.twilio.com/v2/Services/' + serviceSid + '/VerificationCheck',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ 'To': phone, 'Code': code }).toString(),
      }
    );

    if (!twilioResp.ok) {
      const errText = await twilioResp.text();
      let errCode = 'check_failed';
      let errMsg = 'Could not check the code. Try again.';
      try {
        const errJson = JSON.parse(errText);
        if (errJson.code === 20404) { errCode = 'expired'; errMsg = 'Code expired. Send a new one.'; }
        else if (errJson.code === 60200) { errCode = 'invalid_phone'; errMsg = 'Phone number is not valid.'; }
      } catch {}
      return new Response(JSON.stringify({ ok: false, error: errCode, message: errMsg }), { status: 400, headers });
    }

    const twilioJson = await twilioResp.json();
    if (twilioJson.status !== 'approved') {
      return new Response(JSON.stringify({ ok: false, error: 'wrong_code', message: 'That code is not correct. Try again.' }), { status: 400, headers });
    }

    // Issue verifiedToken: phoneHash.emailHash.verifiedAt.exp.sig
    // Client passes this in the Formspree submit so we have a server-signed
    // proof of verification, even though the actual submission goes to Formspree.
    const verifiedAt = Date.now();
    const tokenExp = verifiedAt + 60 * 60 * 1000; // 1 hour to complete the rest of the form
    const tokenPayload = phoneHashCookie + '.' + emailHashCookie + '.' + verifiedAt + '.' + tokenExp;
    const tokenSig = await hmacHex(secret, 'verified.' + tokenPayload);
    const verifiedToken = tokenPayload + '.' + tokenSig;

    // Clear the pending cookie; the client now holds the verified token client-side.
    headers['Set-Cookie'] = 'vh_apply=; HttpOnly; Secure; SameSite=Strict; Path=/api/apply; Max-Age=0';

    return new Response(JSON.stringify({ ok: true, verifiedToken }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'server_error', message: e.message || String(e) }), { status: 500, headers });
  }
}
