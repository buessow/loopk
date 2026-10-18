// Emits Loopk's production environment on stdout. It deliberately never writes
// a file itself; pipe it directly to `install -m 600 /dev/stdin ...` on the
// production host so the Google and database secrets never enter Git.
import fs from 'node:fs';

const [oauthPath] = process.argv.slice(2);
if (!oauthPath) throw new Error('Usage: node scripts/render-production-env.js <google-oauth-client.json>');

const oauth = JSON.parse(fs.readFileSync(oauthPath, 'utf8')).web;
if (!oauth?.client_id || !oauth?.client_secret) throw new Error('Expected a Web application OAuth client JSON file.');
const callback = 'https://loopk.robertbuessow.com/auth/google/callback';
if (!oauth.redirect_uris?.includes(callback)) throw new Error(`OAuth client does not allow ${callback}`);

const password = process.env.POSTGRES_REMOTE_PROD_PASSWORD;
if (!password) throw new Error('POSTGRES_REMOTE_PROD_PASSWORD is not set; run setup-db-users.sh first.');
if (!/^[A-Za-z0-9]+$/.test(password)) throw new Error('Unexpected database password format.');

const adminEmails = process.env.LOOPK_ADMIN_EMAILS || 'buessow@gmail.com';
const lines = [
  'PORT=8084',
  'BASE_URL=https://loopk.robertbuessow.com',
  `DATABASE_URL=postgres://loopk:${password}@127.0.0.1:5432/loopk`,
  `GOOGLE_CLIENT_ID=${oauth.client_id}`,
  `GOOGLE_CLIENT_SECRET=${oauth.client_secret}`,
  `ADMIN_EMAILS=${adminEmails}`,
];
process.stdout.write(lines.join('\n') + '\n');
