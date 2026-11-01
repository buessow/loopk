// Configuration from the environment: only what differs between deployments.

function emails (value) {
  return (value || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function loadConfig (env = process.env) {
  const port = parseInt(env.PORT, 10) || 1337;
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  return {
    port,
    baseUrl,
    // postgres (DATABASE_URL), or memory: an empty database in this process, lost on exit.
    dataSource: env.DATA_SOURCE || 'postgres',
    // For DATA_SOURCE nightscout: the server to read, and an access token on it.
    // Without NIGHTSCOUT_TOKEN, each caller brings their own token (src/passthrough),
    // and, without NIGHTSCOUT_URL, names the server at sign-in.
    nightscout: { url: env.NIGHTSCOUT_URL || '', token: env.NIGHTSCOUT_TOKEN || '' },
    // Encrypts callers' tokens in their session cookies and JWTs (src/auth/seal.js).
    sessionKey: env.SESSION_KEY || '',
    databaseUrl: env.DATABASE_URL || 'postgres://localhost/loopkdev',
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    },
    // Google accounts that may sign in; admins can also manage access tokens.
    allowedEmails: emails(env.ALLOWED_EMAILS),
    adminEmails: emails(env.ADMIN_EMAILS),
    secureCookies: baseUrl.startsWith('https://'),
    // Local development only: the browser is signed in as an admin without Google.
    authDisabled: ['1', 'true'].includes(String(env.AUTH_DISABLED).toLowerCase()),
    // Follow another Nightscout server (its URL and a read access token there),
    // unless an admin has set one on the Access page.
    follow: env.FOLLOW_URL ? { url: env.FOLLOW_URL, token: env.FOLLOW_TOKEN || '' } : null,
    // The person's time zone (IANA, e.g. Europe/Zurich) for the MCP server's
    // answers when the agent names none; else the profile's, which AAPS does
    // not always keep current.
    timeZone: env.TIME_ZONE || '',
    // Where people open loopk, for links to the glucose page in the MCP
    // server's answers; BASE_URL unless the server is reached elsewhere.
    publicUrl: (env.PUBLIC_URL || baseUrl).replace(/\/$/, ''),
  };
}
