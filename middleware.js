// middleware.js — Vercel Edge Middleware.
//
// Gates the internal NOVUS surface (/novus/* pages and /api/novus/* endpoints)
// behind HTTP Basic Auth. This is the "simplest secure human-access" approach
// that fits the existing no-framework Vercel project: server-enforced, no custom
// login UI, no session store, one shared credential in env.
//
// The public demo (/, /capture, /api/chat, /api/scrape) is NOT matched here and
// is completely unaffected.
//
// Two routes are explicitly skipped below despite matching /api/novus/:path*:
//   - /api/novus/webhooks/* — verified by provider signature, not this password.
//   - /api/novus/demo-state — the customer-facing Demo OS read endpoint
//     (api/novus/demo-state.js). It's fetched anonymously by every /d/{slug}
//     page load; gating it here would 401 the public demo for every visitor,
//     silently breaking the C1 case before it ever activates.
// Keeping these auth schemes separate is deliberate.
//
// Env: NOVUS_BASIC_AUTH_USER, NOVUS_BASIC_AUTH_PASS

export const config = {
  matcher: ['/novus/:path*', '/api/novus/:path*'],
};

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default function middleware(req) {
  const { pathname } = new URL(req.url);

  // Future webhook endpoints authenticate by provider signature, not Basic Auth.
  if (pathname.startsWith('/api/novus/webhooks')) return;

  // Public, anonymous, customer-facing read endpoint — see the comment above.
  if (pathname === '/api/novus/demo-state') return;

  const user = process.env.NOVUS_BASIC_AUTH_USER;
  const pass = process.env.NOVUS_BASIC_AUTH_PASS;
  if (!user || !pass) {
    return new Response('NOVUS auth not configured', { status: 500 });
  }

  const header = req.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch { decoded = ''; }
    const sep = decoded.indexOf(':');
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (safeEqual(u, user) && safeEqual(p, pass)) {
      return; // authorised → continue to the route
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="NOVUS", charset="UTF-8"' },
  });
}
