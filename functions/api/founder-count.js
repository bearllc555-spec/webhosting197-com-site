// GET /api/founder-count
// Returns { count, cap, remaining } for the Webhosting197 Launch List

const ALLOWED_ORIGINS = new Set([
  'https://webhosting197.com',
  'https://www.webhosting197.com',
  'https://webhosting197-com.pages.dev'
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://webhosting197.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

const CAP = 50;

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin') || '') });
}

export async function onRequestGet({ request, env }) {
  const headers = { ...corsHeaders(request.headers.get('origin') || ''), 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' };
  try {
    const listId = env.SENDGRID_MARKETING_LIST_ID;
    const apiKey = env.SENDGRID_API_KEY;
    if (!listId || !apiKey) {
      return new Response(JSON.stringify({ count: 0, cap: CAP, remaining: CAP }), { status: 200, headers });
    }
    const r = await fetch('https://api.sendgrid.com/v3/marketing/lists/' + listId + '?contact_sample=false', {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ count: 0, cap: CAP, remaining: CAP, fallback: true }), { status: 200, headers });
    }
    const j = await r.json();
    const count = Math.max(0, j.contact_count || 0);
    const remaining = Math.max(0, CAP - count);
    return new Response(JSON.stringify({ count, cap: CAP, remaining }), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ count: 0, cap: CAP, remaining: CAP, fallback: true }), { status: 200, headers });
  }
}
