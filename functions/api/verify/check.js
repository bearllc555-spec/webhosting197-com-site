// POST /api/verify/check
// Body: { email, code }
// Reads HMAC-signed cookie, verifies signature + email + code + expiry.

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

function constantTimeEqHex(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  const parts = cookies.split(';');
  for (const p of parts) {
    const [k, ...rest] = p.trim().split('=');
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

    const email = ((body && body.email) || '').toString().trim().toLowerCase();
    const code = ((body && body.code) || '').toString().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_email' }), { status: 400, headers });
    }
    if (!/^\d{4,8}$/.test(code)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 400, headers });
    }

    const secret = env.VERIFY_SIGNING_SECRET;
    if (!secret) {
      return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers });
    }

    const token = getCookie(request, 'vh_otp');
    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: 'no_session' }), { status: 400, headers });
    }

    const parts = token.split('.');
    if (parts.length !== 4) {
      return new Response(JSON.stringify({ ok: false, error: 'bad_token' }), { status: 400, headers });
    }
    const [emailHash, codeHash, expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || Date.now() > exp) {
      return new Response(JSON.stringify({ ok: false, error: 'expired' }), { status: 400, headers });
    }

    // Re-derive signature, constant-time compare
    const expectedSig = await hmacHex(secret, emailHash + '.' + codeHash + '.' + exp);
    if (!constantTimeEqHex(sig, expectedSig)) {
      return new Response(JSON.stringify({ ok: false, error: 'tampered' }), { status: 400, headers });
    }

    // Verify email matches
    const submittedEmailHash = await sha256Hex(email);
    if (!constantTimeEqHex(emailHash, submittedEmailHash)) {
      return new Response(JSON.stringify({ ok: false, error: 'email_mismatch' }), { status: 400, headers });
    }

    // Verify code matches
    const submittedCodeHash = await sha256Hex(email + ':' + code);
    if (!constantTimeEqHex(codeHash, submittedCodeHash)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 400, headers });
    }

    // Clear cookie on success
    const clearCookie = 'vh_otp=; Max-Age=0; Path=/api/verify; HttpOnly; Secure; SameSite=Strict';
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...headers, 'Set-Cookie': clearCookie }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'unhandled',
      message: String(err && err.message || err).substring(0, 300)
    }), { status: 500, headers });
  }
}
