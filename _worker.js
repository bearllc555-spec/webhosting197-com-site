// Cloudflare Pages Worker for webhosting197.com
// HTTP Basic Auth on /editor/* paths. Creds from CF Pages env vars.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/editor' || url.pathname.startsWith('/editor/')) {
      const user = env.EDITOR_AUTH_USER;
      const pass = env.EDITOR_AUTH_PASS;
      if (!user || !pass) {
        return new Response('Editor access not configured.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
      const expected = 'Basic ' + btoa(\`\${user}:\${pass}\`);
      const provided = request.headers.get('Authorization') || '';
      if (!timingSafeEqual(provided, expected)) {
        return new Response('Authentication required.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Editor Access"', 'Content-Type': 'text/plain' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
