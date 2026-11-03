// CORS for the APIs a browser elsewhere reads as it reads Nightscout: the
// static pages (loopk.cc) with this server's address and an access token.
// Only the token is allowed, never the session cookie (no credentials), so
// another origin can do only what its token may.

const METHODS = 'GET, POST, PUT, PATCH, DELETE';
// Last-Modified: API v3 history's older form (src/sync/client.js).
const HEADERS = 'Authorization, Content-Type, Last-Modified';

/** Middleware that answers the origins `origins` (exact, e.g. https://loopk.cc) with CORS headers. */
export function cors (origins) {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (!origin || !allowed.has(origin)) return next();
    res.vary('Origin');
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Expose-Headers', 'ETag, Last-Modified');
    if (req.method !== 'OPTIONS') return next();
    res.set('Access-Control-Allow-Methods', METHODS);
    res.set('Access-Control-Allow-Headers', HEADERS);
    res.set('Access-Control-Max-Age', '86400');
    res.status(204).end();
  };
}
