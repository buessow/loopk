// The sign-in page: Google.

const $ = (id) => document.getElementById(id);
const messages = {
  denied: 'This Google account has no access. Ask an administrator to add it.',
  state: 'The sign-in attempt expired. Please try again.',
  unverified: 'This Google account has no verified email address.',
  access_denied: 'Sign-in was cancelled.',
};

function showError (text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

const err = new URLSearchParams(location.search).get('error');
if (err) showError(messages[err] || `Sign-in failed (${err}).`);

fetch('/api/session').then((r) => r.json()).then((s) => {
  if (s.user) location.href = '/';
  else if (s.googleConfigured === false) showError('Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
}).catch(() => {});
