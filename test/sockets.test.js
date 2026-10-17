import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { io } from 'socket.io-client';
import { startServer, tokenFor } from './helpers.js';

let s;
let admin;

before(async () => {
  s = await startServer();
  admin = await tokenFor(s.ctx, 'aaps');
});
after(() => s.close());

function connect (ns) {
  return new Promise((resolve, reject) => {
    const socket = io(s.url + ns, { transports: ['websocket'], forceNew: true });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

test('storage socket: subscribe with access token, receive create events', async () => {
  const socket = await connect('/storage');
  try {
    const ack = await new Promise((resolve) => socket.emit('subscribe', { accessToken: admin.accessToken, collections: ['entries', 'treatments'] }, resolve));
    assert.deepEqual(ack, { success: true, collections: ['entries', 'treatments'] });

    const received = new Promise((resolve) => socket.on('create', resolve));
    await request(s.app).post('/api/v3/entries').set('Authorization', `Bearer ${admin.jwt}`)
      .send({ date: Date.now(), sgv: 111, type: 'sgv', device: 'x', app: 'AAPS', utcOffset: 0 }).expect(201);
    const event = await received;
    assert.equal(event.colName, 'entries');
    assert.equal(event.doc.sgv, 111);
    assert.ok(event.doc.srvModified);
  } finally {
    socket.close();
  }
});

test('storage socket rejects bad tokens', async () => {
  const socket = await connect('/storage');
  try {
    const ack = await new Promise((resolve) => socket.emit('subscribe', { accessToken: 'bad-token' }, resolve));
    assert.equal(ack.success, false);
  } finally {
    socket.close();
  }
});
