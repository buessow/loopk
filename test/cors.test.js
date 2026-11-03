import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { loadConfig } from '../src/config.js';

let s;

before(async () => {
  s = await startServer();
});
after(() => s.close());

test('the static pages may read API v3 with an access token', async () => {
  const pre = await request(s.app).options('/api/v3/entries')
    .set('Origin', 'https://loopk.cc')
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'authorization')
    .expect(204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://loopk.cc');
  assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
  assert.match(pre.headers['access-control-allow-methods'], /POST/);
  assert.equal(pre.headers['access-control-allow-credentials'], undefined);

  const { accessToken: token } = await tokenFor(s.ctx, 'pages', { canWrite: false });
  const { body: { token: jwt } } = await request(s.app).get(`/api/v2/authorization/request/${token}`)
    .set('Origin', 'https://loopk.cc').expect(200)
    .expect('Access-Control-Allow-Origin', 'https://loopk.cc');
  const res = await request(s.app).get('/api/v3/entries?limit=1')
    .set('Origin', 'https://loopk.cc').set('Authorization', `Bearer ${jwt}`).expect(200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://loopk.cc');
  assert.match(res.headers['access-control-expose-headers'], /ETag/);
});

test('other origins and other routes get no CORS headers', async () => {
  const other = await request(s.app).options('/api/v3/entries')
    .set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  const session = await request(s.app).get('/api/session').set('Origin', 'https://loopk.cc');
  assert.equal(session.headers['access-control-allow-origin'], undefined);
});

test('CORS_ORIGINS names the origins, or none', () => {
  assert.deepEqual(loadConfig({}).corsOrigins, ['https://loopk.cc']);
  assert.deepEqual(loadConfig({ CORS_ORIGINS: 'https://a.example/, http://localhost:1350' }).corsOrigins, ['https://a.example', 'http://localhost:1350']);
  assert.deepEqual(loadConfig({ CORS_ORIGINS: 'none' }).corsOrigins, []);
});
