// POST /api/verify/check
// Body: { email, code }
// On success:
//   1) Validates HMAC-signed cookie + email + code + expiry
//   2) Sends a branded confirmation email to the user via SendGrid
//   3) Sends an operator-notification email to OPERATOR_NOTIFY_EMAIL via SendGrid
//   4) Clears the cookie

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

async function sendMail(env, to, subject, htmlBody, textBody, replyTo) {
  const from = { email: env.SENDGRID_FROM_EMAIL || 'hello@webhosting197.com', name: env.SENDGRID_FROM_NAME || 'webhosting197' };
  const payload = {
    from: from,
    personalizations: [{ to: [{ email: to }] }],
    subject: subject,
    content: [
      { type: 'text/plain', value: textBody },
      { type: 'text/html', value: htmlBody }
    ]
  };
  if (replyTo) payload.reply_to = { email: replyTo };
  return fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function userConfirmationHtml(email) {
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>You are on the webhosting197 launch list</title></head>',
    '<body style="margin:0;padding:0;background:#FAFAFA;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,system-ui,sans-serif;color:#1C1B1F;-webkit-font-smoothing:antialiased;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFAFA;padding:40px 20px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#FFFFFF;border-radius:12px;border:1px solid #E8E8E8;">',
    '<tr><td style="padding:36px 36px 0 36px;"><span style="font-size:21px;font-weight:800;color:#1C1B1F;letter-spacing:-.04em;">/webhosting</span><span style="font-size:21px;font-weight:800;color:#2563EB;letter-spacing:-.05em;">197</span></td></tr>',
    '<tr><td style="padding:28px 36px 14px 36px;font-size:18px;font-weight:600;color:#1C1B1F;letter-spacing:-.02em;">You are on the launch list.</td></tr>',
    '<tr><td style="padding:0 36px 18px 36px;font-size:14.5px;color:#5C5C66;line-height:1.6;">Thanks for reserving a spot at webhosting197. We will email <strong style="color:#1C1B1F;">' + email + '</strong> the moment we open.</td></tr>',
    '<tr><td style="padding:0 36px 24px 36px;font-size:14.5px;color:#5C5C66;line-height:1.6;">Founder pricing for the first 50 confirmed signups: <strong style="color:#1C1B1F;">$197 once</strong> (vs. $297 after).</td></tr>',
    '<tr><td style="padding:0 36px 6px 36px;font-size:13px;color:#85858C;line-height:1.55;">If you have questions, just reply to this email. No drip sequences, no upsells.</td></tr>',
    '<tr><td style="padding:24px 36px;border-top:1px solid #E8E8E8;font-size:13px;color:#5C5C66;line-height:1.6;">&mdash; Anthony<br><span style="color:#85858C;">webhosting197.com</span></td></tr>',
    '<tr><td style="padding:18px 36px 24px 36px;border-top:1px solid #E8E8E8;font-size:11.5px;color:#85858C;letter-spacing:.06em;text-transform:uppercase;">Another SlatePress company</td></tr>',
    '</table>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;padding-top:20px;"><tr><td style="font-size:11.5px;color:#85858C;text-align:center;line-height:1.6;">webhosting197 &middot; 25 Hughes Place, Little Falls, NJ 07424<br>You are receiving this because you reserved a spot on the webhosting197 launch list.</td></tr></table>',
    '</td></tr></table></body></html>'
  ].join('');
}

function userConfirmationText(email) {
  return [
    'You are on the webhosting197 launch list.',
    '',
    'Thanks for reserving a spot. We will email ' + email + ' the moment we open.',
    '',
    'Founder pricing for the first 50 confirmed signups: $197 once (vs. $297 after).',
    '',
    'If you have questions, just reply to this email.',
    '',
    '-- Anthony',
    'webhosting197.com',
    'Another SlatePress company'
  ].join('\n');
}

function operatorNotifyHtml(email, ts) {
  return '<p>New verified launch list signup:</p><p><strong>' + email + '</strong></p><p>Verified at ' + ts + ' UTC</p>';
}
function operatorNotifyText(email, ts) {
  return 'New verified launch list signup:\n\n' + email + '\n\nVerified at ' + ts + ' UTC';
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
    const expectedSig = await hmacHex(secret, emailHash + '.' + codeHash + '.' + exp);
    if (!constantTimeEqHex(sig, expectedSig)) {
      return new Response(JSON.stringify({ ok: false, error: 'tampered' }), { status: 400, headers });
    }
    const submittedEmailHash = await sha256Hex(email);
    if (!constantTimeEqHex(emailHash, submittedEmailHash)) {
      return new Response(JSON.stringify({ ok: false, error: 'email_mismatch' }), { status: 400, headers });
    }
    const submittedCodeHash = await sha256Hex(email + ':' + code);
    if (!constantTimeEqHex(codeHash, submittedCodeHash)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 400, headers });
    }

    // Send branded confirmation email + operator notification via SendGrid (parallel, allSettled)
    const replyTo = env.SENDGRID_FROM_EMAIL || 'hello@webhosting197.com';
    const operatorEmail = env.OPERATOR_NOTIFY_EMAIL || 'bearllc555@gmail.com';
    const ts = new Date().toISOString();
    const tasks = [
      sendMail(env, email, 'You are on the webhosting197 launch list', userConfirmationHtml(email), userConfirmationText(email), replyTo),
      sendMail(env, operatorEmail, 'New webhosting197 launch list signup: ' + email, operatorNotifyHtml(email, ts), operatorNotifyText(email, ts), replyTo)
    ];
    // Add to SendGrid Marketing Contacts list (if list ID is configured)
    if (env.SENDGRID_MARKETING_LIST_ID) {
      tasks.push(fetch('https://api.sendgrid.com/v3/marketing/contacts', {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          list_ids: [env.SENDGRID_MARKETING_LIST_ID],
          contacts: [{ email: email }]
        })
      }));
    }
    await Promise.allSettled(tasks);

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
