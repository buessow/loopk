import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { loggedPath, logRequests } from '../src/monitoring/requests.js';

function appWithLog () {
  const logs = { log: [], error: [] };
  const logger = { log: (line) => logs.log.push(line), error: (line) => logs.error.push(line) };
  const app = express();
  app.use(logRequests(logger));
  app.get('/api/v3/entries', (req, res) => res.json([]));
  app.get('/api/v3/broken', (req, res) => res.status(500).end());
  app.get('/app.js', (req, res) => res.end());
  return { app, logs };
}

test('loggedPath drops the query string and redacts access tokens', () => {
  assert.equal(loggedPath('/api/v3/entries?token=secret&limit=5'), '/api/v3/entries');
  assert.equal(loggedPath('/api/v2/authorization/request/aaps-0123456789abcdef'), '/api/v2/authorization/request/<token>');
});

test('logRequests logs API requests with status and duration, server errors to stderr', async () => {
  const { app, logs } = appWithLog();
  await request(app).get('/api/v3/entries?token=secret');
  await request(app).get('/api/v3/broken');
  await request(app).get('/app.js');

  assert.equal(logs.log.length, 1);
  assert.match(logs.log[0], /^GET \/api\/v3\/entries 200 \d+ms$/);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0], /^GET \/api\/v3\/broken 500 \d+ms$/);
});
