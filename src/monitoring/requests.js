// Access tokens can appear in the token-exchange path and in ?token=, so the
// log keeps only the path, with the token segment redacted.
const TOKEN_PATH = /^(\/api\/v2\/authorization\/request\/)[^/]+/;

/** The request path as logged: no query string, no access token. */
export function loggedPath (url) {
  return url.split('?')[0].replace(TOKEN_PATH, '$1<token>');
}

/**
 * Log one line per API request when its response finishes. Server errors go
 * to stderr, which the journald log driver records with error priority.
 */
export function logRequests (logger = console) {
  return (req, res, next) => {
    if (!req.originalUrl.startsWith('/api')) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const line = `${req.method} ${loggedPath(req.originalUrl)} ${res.statusCode} ${ms.toFixed(0)}ms`;
      if (res.statusCode >= 500) logger.error(line);
      else logger.log(line);
    });
    next();
  };
}
