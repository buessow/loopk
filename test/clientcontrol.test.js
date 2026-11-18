import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tokenFor } from './helpers.js';
import { NightscoutClient } from '../src/sync/client.js';
import * as cc from '../src/clientcontrol/crypto.js';
import { ClientControl, DOC_DATE, ids, memoryStore } from '../src/clientcontrol/client.js';
import { PROFILE_KEY, parseProfileData, profileDataWith } from '../src/clientcontrol/profile.js';

const subtle = globalThis.crypto.subtle;
const seq = (n, from) => Uint8Array.from({ length: n }, (_, i) => from + i);
const H = 3600;

// --- AAPS's golden vectors (aaps-dev ClientControlCryptoVectorsTest) --------

test('signatures and PIN wrapping match AAPS byte for byte', async () => {
  const secret = seq(32, 0);
  assert.equal(await cc.sign(secret, 'clientId=abc|counter=5|type=SceneStop|timestamp=1785992179555'), 'e2ac7455db1ee06145fe8432e115eaca1a4e81375703ad907251cbb9d223d216');
  assert.equal(await cc.sign(secret, ''), 'd38b42096d80f45f826b44a9d5607de72496a415d3f4a1a8c88e3bb9da8dc1cb');
  assert.equal(await cc.sign(secret, 'poznámka ěščřž'), 'fcefc8439c7d9f1d149bee6a4dfa2ec4631f8d23a8fd35bc9444c86a4a19b36d');

  const salt = seq(16, 0xa0);
  const iv = seq(12, 0xb0);
  const plain = new TextEncoder().encode('{"clientId":"abc","secret":"00","expiresAt":1785992179555}');
  assert.equal(cc.toHex(await cc.wrap(plain, '12345678', salt, iv)),
    'f864c764382a5e82af17fccf545a14fea3b29eae0784eb2b1630ffe179e58b31c5fc8291afde74f7a0867579b244c6213a12eb9bf1382b1b6c569d2d1f74c25b52c6b253943d87026018');
  assert.equal(cc.toHex(await cc.wrap(Uint8Array.of(1, 2, 3, 4), '00000000', salt, iv)), 'f0ef78af68d41f05d7bfed02b15a252856f3620c');
  assert.equal(await cc.unwrap(await cc.wrap(plain, '11111111', salt, iv), '22222222', salt, iv), null);
});

test('the secret is used as a key that cannot be read back', async () => {
  const key = await cc.hmacKey(seq(32, 0));
  await assert.rejects(subtle.exportKey('raw', key));
  assert.equal(await cc.sign(key, ''), 'd38b42096d80f45f826b44a9d5607de72496a415d3f4a1a8c88e3bb9da8dc1cb');
});

test('both sides of the key exchange come to the same keys, bound to the old secret', async () => {
  const old = seq(32, 0);
  const client = await cc.newKeyPair();
  const master = await cc.newKeyPair();
  const a = await cc.deriveKeys(client.privateKey, master.publicKey, old, 'c1', client.publicKey, master.publicKey);
  const b = await cc.deriveKeys(master.privateKey, client.publicKey, old, 'c1', client.publicKey, master.publicKey);
  assert.deepEqual(a, b);
  assert.equal(a.secret.length, 32);
  assert.notDeepEqual(a.secret, a.tokenKey);
  const other = await cc.deriveKeys(client.privateKey, master.publicKey, seq(32, 9), 'c1', client.publicKey, master.publicKey);
  assert.notDeepEqual(other.secret, a.secret);
});

// --- local_profile_data ----------------------------------------------------

const flat = (v) => [[0, v]];
const aiTest = {
  units: 'mg/dl', dia: 6,
  basal: [[0, 0.8], [6 * H, 1.1]], ic: flat(9), isf: flat(90),
  targetLow: [[0, 100], [22 * H, 110]], targetHigh: flat(120),
};

test('AI Test goes into AAPS\'s profiles in each profile\'s units, the others kept', () => {
  const current = JSON.stringify({ lastChange: 5000, profiles: [{ name: 'Day', mgdl: false, basal: [] }, { name: 'Other', mgdl: false }] });
  const { value, lastModified, adds } = profileDataWith(current, aiTest, 'Day', 1000);
  assert.equal(adds, false);
  assert.equal(lastModified, 5001);
  const doc = JSON.parse(value);
  assert.equal(doc.lastChange, 5001);
  assert.deepEqual(doc.profiles.map((p) => p.name), ['Day', 'Other']);
  const day = doc.profiles[0];
  assert.equal(day.mgdl, false);
  assert.deepEqual(day.isf, [{ time: '00:00', timeAsSeconds: 0, value: 5 }]);
  assert.deepEqual(day.basal.map((b) => b.time), ['00:00', '06:00']);
  // the targets change at the same times, as AAPS reads them
  assert.deepEqual(day.targetLow.map((b) => [b.timeAsSeconds, b.value]), [[0, 5.6], [22 * H, 6.1]]);
  assert.deepEqual(day.targetHigh.map((b) => [b.timeAsSeconds, b.value]), [[0, 6.7], [22 * H, 6.7]]);
  assert.equal('dia' in day, false);

  const added = profileDataWith(current, aiTest, 'New', 9000);
  assert.equal(added.adds, true);
  assert.equal(added.lastModified, 9000);
  assert.deepEqual(JSON.parse(added.value).profiles.map((p) => [p.name, p.mgdl]), [['Day', false], ['Other', false], ['New', false]]);
  assert.equal(JSON.parse(profileDataWith('', aiTest, 'P', 1).value).profiles[0].mgdl, true);
});

test('a schedule off the hour is refused, as AAPS would read it as zero', () => {
  assert.throws(() => profileDataWith('', { ...aiTest, basal: [[0, 1], [6.5 * H, 1.2]] }, 'P'), /by the hour only: the basal of AI Test changes at 06:30/);
  assert.throws(() => profileDataWith('not json', aiTest, 'P'), /could not be read/);
});

// --- a fake AAPS master, over loopk's API v3 settings ------------------------

/**
 * Answers as aaps-dev's ClientControlReceiver does, in order: signature,
 * counter, expiry, role; hello answered by the key exchange, ping by the
 * signing key, preferences_update by last writer wins and a new cold doc.
 */
async function fakeMaster (client, { role = 'Admin', profiles, modified = 0, offline = false } = {}) {
  const signing = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const signingKey = cc.toB64(await subtle.exportKey('raw', signing.publicKey));
  const m = {
    clientId: 'client-1', secret: cc.randomBytes(32), pending: null, lastCounter: 0, received: [],
    prefs: { [PROFILE_KEY]: profiles }, modified: { [PROFILE_KEY]: modified }, role, offline, signedAt: 1000,
  };
  const put = (identifier, field, value) => client.put(`/api/v3/settings/${identifier}`, { date: DOC_DATE, utcOffset: 0, app: 'AAPS', schemaVersion: 1, [field]: value });
  m.publishCold = async () => {
    const signed = JSON.stringify({ signedAt: ++m.signedAt, runningConfig: { syncedPrefs: m.prefs, authorizedClients: { clientIds: [m.clientId], roles: { [m.clientId]: m.role } } } });
    const signature = cc.toB64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing.privateKey, new TextEncoder().encode(`aaps-settings-v1|aaps|${signed}`)));
    await client.put('/api/v3/settings/aaps', { date: DOC_DATE, utcOffset: 0, app: 'AAPS', schemaVersion: 2, signed, signature });
  };
  m.offer = async (pin) => {
    const payload = { v: 1, masterInstallId: 'master-1', clientId: m.clientId, secretHex: cc.toHex(m.secret), expiresAt: Date.now() + 600000, role: m.role, name: 'loopk' };
    const salt = cc.randomBytes(16);
    const iv = cc.randomBytes(12);
    const wrapped = await cc.wrap(new TextEncoder().encode(JSON.stringify(payload)), pin, salt, iv);
    await put(`${ids.offer}${m.clientId}`, 'offer', { schemaVersion: 1, clientId: m.clientId, expiresAt: payload.expiresAt, kdfSaltB64: cc.toB64(salt), ivB64: cc.toB64(iv), wrappedB64: cc.toB64(wrapped) });
  };
  const ack = async (counter, status, reason = null, payload = null) => {
    const a = { clientId: m.clientId, commandCounter: counter, phase: 'Done', status, reason, payload, timestamp: Date.now() };
    await put(ids.ack(m.clientId), 'ack', { ...a, signature: await cc.sign(m.secret, cc.ackText(a)) });
  };
  // Called with each doc the client writes, as the master's websocket would.
  m.onDoc = async (identifier, doc) => {
    const e = doc.envelope;
    if (m.offline || !e) return;
    let ok = await cc.verify(m.secret, cc.envelopeText(e), e.signature);
    if (!ok && m.pending && await cc.verify(m.pending, cc.envelopeText(e), e.signature)) {
      [m.secret, m.pending, ok] = [m.pending, null, true];
    }
    if (!ok || e.counter <= m.lastCounter) return;
    m.lastCounter = e.counter;
    const message = JSON.parse(e.payload);
    m.received.push({ identifier, ...message });
    if (e.validUntil < Date.now()) return e.wantsAck && ack(e.counter, 'Expired', 'expired before master applied it');
    if (message.type === 'hello') {
      const own = await cc.newKeyPair();
      const keys = await cc.deriveKeys(own.privateKey, message.publicKey, m.secret, m.clientId, message.publicKey, own.publicKey);
      m.pending = keys.secret;
      const answer = { clientId: m.clientId, clientPublicKey: message.publicKey, masterPublicKey: own.publicKey, timestamp: Date.now() };
      return put(ids.key(m.clientId), 'key', { ...answer, signature: await cc.sign(m.secret, cc.keyExchangeText(answer)) });
    }
    if (message.type === 'ping') return ack(e.counter, 'Ok', null, JSON.stringify({ signingKey }));
    if (message.type === 'preferences_update') {
      if (m.role !== 'Admin') return ack(e.counter, 'Failed', 'NotAllowedForRole');
      for (const [key, pushed] of Object.entries(message.prefs)) {
        if (pushed.lastModified <= m.modified[key]) continue;
        m.prefs[key] = pushed.value;
        m.modified[key] = pushed.lastModified;
      }
      await ack(e.counter, 'Ok');
      return m.publishCold();
    }
  };
  await m.publishCold();
  return m;
}

/** A client of loopk's API v3 whose writes the master sees at once. */
function watched (client, master) {
  return {
    get: (path) => client.get(path),
    put: async (path, doc) => {
      const reply = await client.put(path, doc);
      await master.onDoc(decodeURIComponent(path.split('/').pop()), doc);
      return reply;
    },
  };
}

/** Seals with a key of its own, as the passkey does in the browser. */
async function testVault () {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    seal: async (bytes) => {
      const iv = cc.randomBytes(12);
      return { iv: cc.toB64(iv), data: cc.toB64(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
    },
    open: async (s) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: cc.fromB64(s.iv) }, key, cc.fromB64(s.data))),
  };
}

let s;
let writer;
before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'clientcontrol');
});
after(() => s.close());

let run = 0;
async function setup (options = {}) {
  // Each test its own client id, so the docs of one don't answer another.
  const raw = new NightscoutClient({ url: s.url, token: writer.accessToken });
  const master = await fakeMaster(raw, { profiles: JSON.stringify({ lastChange: 1000, profiles: [{ name: 'Day', mgdl: true, basal: [{ time: '00:00', timeAsSeconds: 0, value: 1 }] }, { name: 'Night', mgdl: true }] }), ...options });
  master.clientId = `client-${++run}`;
  await master.publishCold();
  const store = memoryStore();
  const control = new ClientControl({ client: watched(raw, master), store, pollMs: 5, keyWaitMs: 300, coldWaitMs: 300, roundTripMs: 2000, pingMs: 2000, ackMarginMs: 200 });
  return { master, store, control, vault: await testVault() };
}

test('pairing by PIN replaces the secret by the key exchange and keeps only sealed secrets', async () => {
  const { master, store, control, vault } = await setup();
  await master.offer('24681357');
  await assert.rejects(control.pair('11111111', vault), /No pairing offer opens with this PIN/);

  const rec = await control.pair('24681357', vault, { url: s.url });
  assert.equal(rec.clientId, master.clientId);
  assert.equal(rec.role, 'Admin');
  assert.equal(rec.replaced, true);
  assert.equal(master.pending, null, 'the ping signed with the new secret promoted it');
  assert.deepEqual(master.received.map((r) => r.type), ['hello', 'ping']);
  assert.equal(master.received[0].identifier, ids.hello(master.clientId));
  assert.equal(master.received[1].identifier, ids.command('ping', master.clientId));
  assert.ok(rec.signingKey);
  assert.equal(rec.counter, 2);
  // only sealed: the record holds neither secret in the clear, and another vault can't open it
  const kept = JSON.stringify(store.load());
  assert.ok(!kept.includes(cc.toHex(master.secret)));
  assert.deepEqual(await vault.open(rec.secret), master.secret);
  await assert.rejects((await testVault()).open(rec.secret));

  const st = await control.status();
  assert.equal(st.listed, true);
  assert.equal(st.verified, true);
});

test('copying a profile sends AAPS its profiles with the one replaced, and sees them arrive', async () => {
  const { master, control, vault } = await setup();
  await master.offer('13572468');
  await control.pair('13572468', vault);

  const result = await control.copyProfile(aiTest, 'Day', vault);
  assert.deepEqual(result, { adds: false, confirmed: true });
  const sent = master.received.at(-1);
  assert.equal(sent.type, 'preferences_update');
  assert.equal(sent.identifier, ids.command('preferences_update', master.clientId));
  const { profiles } = parseProfileData(master.prefs[PROFILE_KEY]);
  assert.deepEqual(profiles.map((p) => p.name), ['Day', 'Night']);
  assert.deepEqual(profiles[0].isf, [{ time: '00:00', timeAsSeconds: 0, value: 90 }]);

  // a profile AAPS doesn't have is added
  assert.deepEqual(await control.copyProfile(aiTest, 'Sport', vault), { adds: true, confirmed: true });
  assert.deepEqual(parseProfileData(master.prefs[PROFILE_KEY]).profiles.map((p) => p.name), ['Day', 'Night', 'Sport']);
});

test('what AAPS refuses or drops is reported', async () => {
  const { master, control, vault } = await setup();
  await master.offer('11223344');
  await control.pair('11223344', vault);

  // AAPS changed its profiles later than now: last writer wins, and it keeps its own
  master.modified[PROFILE_KEY] = Date.now() + 3600000;
  assert.deepEqual(await control.copyProfile(aiTest, 'Day', vault), { adds: false, confirmed: false });

  master.role = 'Viewer';
  await master.publishCold();
  await assert.rejects(control.copyProfile(aiTest, 'Day', vault), (err) => err.code === 'NotAllowedForRole');

  master.role = 'Admin';
  await master.publishCold();
  master.offline = true;
  await assert.rejects(control.copyProfile(aiTest, 'Day', vault), (err) => err.code === 'NoReply');
});

test('settings not signed by the master are refused once its key is known', async () => {
  const { master, control, vault, store } = await setup();
  await master.offer('55667788');
  await control.pair('55667788', vault);
  const raw = new NightscoutClient({ url: s.url, token: writer.accessToken });
  const forged = JSON.stringify({ signedAt: 1e13, runningConfig: { syncedPrefs: { [PROFILE_KEY]: '' }, authorizedClients: { clientIds: [master.clientId], roles: { [master.clientId]: 'Admin' } } } });
  await raw.put('/api/v3/settings/aaps', { date: DOC_DATE, utcOffset: 0, app: 'AAPS', schemaVersion: 2, signed: forged, signature: 'AAAA' });
  await assert.rejects(control.copyProfile(aiTest, 'Day', vault), /do not carry AAPS's signature/);
  assert.equal(master.received.at(-1).type, 'ping', 'nothing was sent');
  assert.ok(store.load().signingKey);
});

test('a master that does not answer the hello leaves the pairing secret in use, and the next change tries again', async () => {
  const { master, control, vault } = await setup();
  await master.offer('99887766');
  master.offline = true;
  const rec = await control.pair('99887766', vault);
  assert.equal(rec.replaced, false);
  assert.equal(rec.signingKey, null);
  master.offline = false;
  assert.deepEqual(await control.copyProfile(aiTest, 'Night', vault), { adds: false, confirmed: true });
  assert.equal(control.paired().replaced, true);
  assert.deepEqual(master.received.map((r) => r.type), ['hello', 'ping', 'preferences_update']);
});
