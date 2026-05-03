// POST /api/verify/start
// Body: { email }
// 1) Generates a 6-digit OTP
// 2) Sends it via SendGrid using our Dynamic Template
// 3) Sets an HttpOnly HMAC-signed cookie with hashed (email, code, exp)
// 4) Returns ok

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

function generateCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
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
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_email' }), { status: 400, headers });
    }

    const apiKey = env.SENDGRID_API_KEY;
    const templateId = env.SENDGRID_TEMPLATE_ID;
    const fromEmail = env.SENDGRID_FROM_EMAIL || 'hello@webhosting197.com';
    const fromName = env.SENDGRID_FROM_NAME || 'webhosting197';
    const secret = env.VERIFY_SIGNING_SECRET;
    if (!apiKey || !templateId || !secret) {
      return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers });
    }

    const code = generateCode();
    const exp = Date.now() + 10 * 60 * 1000; // 10 min
    const emailHash = await sha256Hex(email);
    const codeHash = await sha256Hex(email + ':' + code);
    const payload = emailHash + '.' + codeHash + '.' + exp;
    const sig = await hmacHex(secret, payload);
    const token = payload + '.' + sig;

    // Send via SendGrid using our Dynamic Template ({{twilio_code}} merge tag)
    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { email: fromEmail, name: fromName },
        personalizations: [{
          to: [{ email: email }],
          dynamic_template_data: { twilio_code: code }
        }],
        template_id: templateId
      })
    });

    if (!sgRes.ok && sgRes.status !== 202) {
      const text = await sgRes.text();
      return new Response(JSON.stringify({
        ok: false,
        error: 'sendgrid_error',
        status: sgRes.status,
        sendgrid_message: text.substring(0, 300)
      }), { status: 502, headers });
    }

    // Cookie: HttpOnly, Secure, SameSite=Strict, scoped to /api/verify, 10 min
    const cookie = 'vh_otp=' + token + '; Max-Age=600; Path=/api/verify; HttpOnly; Secure; SameSite=Strict';
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...headers, 'Set-Cookie': cookie }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'unhandled',
      message: String(err && err.message || err).substring(0, 300)
    }), { status: 500, headers });
  }
}
