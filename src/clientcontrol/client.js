// loopk as a client of an AAPS 4.0 master (aaps-dev _docs/CLIENT_CONTROL.md):
// paired by the PIN the master shows, it writes signed commands to the
// Nightscout `settings` collection the master reads, and reads the master's
// signed acks and settings docs there. Wire format as aaps-dev
// plugins/sync/.../nsclientV3/clientcontrol/*.
//
// What it needs is passed in, so the same code runs in the browser and in
// tests: `client` reads and writes API v3 (NightscoutClient), `store` keeps
// the pairing record (load, save, and lock(fn) so no two tabs use one
// counter), and each operation that signs gets a `vault` { seal(bytes),
// open(sealed) } that keeps the secrets sealed (in the browser, with the
// person's passkey). The record holds secrets only sealed.

import { ackText, deriveKeys, envelopeText, fromHex, hmacKey, keyExchangeText, newKeyPair, openOffer, sign, verify, verifyMasterDoc } from './crypto.js';
import { PROFILE_KEY, parseProfileData, profileDataWith } from './profile.js';

const PREFIX = 'aaps_clientcontrol_';
export const ids = {
  offer: `${PREFIX}offer_`,
  hello: (clientId) => `${PREFIX}hello_${clientId}`,
  command: (type, clientId) => `${PREFIX}cmd_${type}_${clientId}`,
  ack: (clientId) => `${PREFIX}ack_${clientId}`,
  key: (clientId) => `${PREFIX}key_${clientId}`,
  cold: 'aaps',
};
// The fixed date AAPS gives these docs, so they never show in a time range.
export const DOC_DATE = 946684800001;
const SCHEMA_VERSION = 1;
const FIRE_AND_FORGET_TTL = 5 * 60000;
export const ROUND_TRIP_TTL = 8000;
const PING_TTL = 10000;
// After a command's validUntil: the master's ack still has to travel.
const ACK_MARGIN = 6000;

const REASONS = {
  NotAllowedForRole: 'AAPS does not let loopk\'s role change profiles. Pair loopk again with the Admin role.',
  ControlDisabled: 'Client control is off in AAPS. Turn it on there, or unpair loopk on the Access page to write a profile store instead.',
  OtherToken: 'AAPS expects loopk to write with the Nightscout token it was given; it refused this one.',
  NotPaired: 'AAPS does not know loopk as a client any more. Pair again on the Access page.',
};

const sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error with AAPS's reason (`code`) for refusing. */
export class ControlError extends Error {
  constructor (message, code = null) {
    super(message);
    this.code = code;
  }
}

export class ClientControl {
  /** @param options { client, store, now, sleep, pollMs, keyWaitMs, coldWaitMs, roundTripMs, pingMs, ackMarginMs } */
  constructor ({ client, store, now = Date.now, sleep = sleeper, pollMs = 1000, keyWaitMs = 60000, coldWaitMs = 20000, roundTripMs = ROUND_TRIP_TTL, pingMs = PING_TTL, ackMarginMs = ACK_MARGIN }) {
    Object.assign(this, { client, store, now, sleep, pollMs, keyWaitMs, coldWaitMs, roundTripMs, pingMs, ackMarginMs });
  }

  async read (identifier) {
    try {
      return await this.client.get(`/api/v3/settings/${encodeURIComponent(identifier)}`);
    } catch (err) {
      if (/HTTP (404|410)\b/.test(err.message)) return null;
      throw err;
    }
  }

  write (identifier, field, value) {
    const doc = { date: DOC_DATE, utcOffset: 0, app: 'AAPS', schemaVersion: SCHEMA_VERSION, [field]: value };
    return this.client.put(`/api/v3/settings/${encodeURIComponent(identifier)}`, doc);
  }

  /** The pairing record, or null. */
  paired () {
    return this.store.load();
  }

  // --- pairing --------------------------------------------------------------

  /** The PairingPayload of the one live offer the PIN opens. */
  async findOffer (pin) {
    const docs = await this.client.get('/api/v3/settings?limit=500');
    const now = this.now();
    const found = [];
    for (const doc of docs) {
      if (!doc.identifier?.startsWith(ids.offer) || !doc.offer) continue;
      if (doc.offer.expiresAt > 0 && doc.offer.expiresAt < now) continue;
      const payload = await openOffer(doc.offer, pin, now);
      if (payload) found.push(payload);
    }
    if (!found.length) throw new ControlError('No pairing offer opens with this PIN. Check it, and that the PIN on the phone has not expired.', 'NoMatch');
    if (found.length > 1) throw new ControlError('More than one offer opens with this PIN. Make a new one on the phone.', 'Ambiguous');
    return found[0];
  }

  /**
   * Pairs with the offer the PIN opens, then replaces the pairing secret by
   * the key exchange and asks for the master's signing key (ping). Returns the record.
   */
  async pair (pin, vault, { url = null } = {}) {
    const offer = await this.findOffer(pin);
    await this.store.lock(async () => {
      this.store.save({
        url,
        clientId: offer.clientId,
        masterInstallId: offer.masterInstallId,
        role: offer.role || null,
        name: offer.name || null,
        secret: await vault.seal(fromHex(offer.secretHex)),
        previous: null,
        replaced: false,
        counter: 0,
        signingKey: null,
        pairedAt: this.now(),
        lastAnswer: null,
      });
    });
    await this.keyExchange(vault);
    return this.paired();
  }

  /** Forgets the pairing in this browser. The master keeps listing loopk until it is removed there. */
  async unpair () {
    await this.store.lock(async () => this.store.save(null));
  }

  /**
   * Hello with a new key: the master answers with its key, which with ours
   * and the pairing secret gives a new secret no one who saw the PIN knows.
   * Then a ping, whose answer carries the master's signing key. Waits up to
   * keyWaitMs; the pairing secret keeps working meanwhile. Returns whether the secret was replaced.
   */
  async keyExchange (vault) {
    const pair = await newKeyPair();
    const now = this.now();
    await this.send({ type: 'hello', protocolVersion: 1, publicKey: pair.publicKey }, vault, { validUntil: now + FIRE_AND_FORGET_TTL, wantsAck: false });
    const until = now + this.keyWaitMs;
    for (;;) {
      const answer = (await this.read(ids.key(this.paired().clientId)))?.key;
      if (answer && answer.clientPublicKey === pair.publicKey && await this.completeKeyExchange(answer, pair, vault)) break;
      if (this.now() >= until) return false;
      await this.sleep(this.pollMs);
    }
    await this.ping(vault);
    return true;
  }

  async completeKeyExchange (answer, pair, vault) {
    return this.store.lock(async () => {
      const rec = this.paired();
      if (!rec || answer.clientId !== rec.clientId) return false;
      const old = await vault.open(rec.secret);
      if (!await verify(old, keyExchangeText(answer), answer.signature)) return false;
      const keys = await deriveKeys(pair.privateKey, answer.masterPublicKey, old, rec.clientId, pair.publicKey, answer.masterPublicKey);
      // The token the master may hand over (tokenIv, token) is not taken:
      // loopk writes with the access it has (the session, or the token entered).
      this.store.save({ ...rec, previous: rec.secret, secret: await vault.seal(keys.secret), replaced: true });
      return true;
    });
  }

  /** Asks the master to answer; its answer gives its signing key. Returns the ack. */
  async ping (vault) {
    const validUntil = this.now() + this.pingMs;
    const counter = await this.send({ type: 'ping' }, vault, { validUntil, wantsAck: true });
    const ack = await this.waitAck(counter, validUntil + this.ackMarginMs, vault);
    let signingKey = null;
    try {
      signingKey = ack.status === 'Ok' && ack.payload ? JSON.parse(ack.payload).signingKey : null;
    } catch { /* an answer without a key */ }
    if (signingKey) await this.store.lock(async () => this.store.save({ ...this.paired(), signingKey }));
    return ack;
  }

  // --- commands and acks ----------------------------------------------------

  /** Signs `message` ({ type, ... }) with the next counter and writes it. Returns the counter. */
  async send (message, vault, { validUntil, wantsAck }) {
    const payload = JSON.stringify(message);
    const envelope = await this.store.lock(async () => {
      const rec = this.paired();
      if (!rec) throw new ControlError('loopk is not paired with AAPS in this browser.', 'NotPaired');
      const counter = rec.counter + 1;
      // Counted before it is sent: a counter is never used twice, even if the write fails.
      this.store.save({ ...rec, counter });
      const draft = { clientId: rec.clientId, counter, timestamp: this.now(), type: message.type, payload, signature: '', validUntil, wantsAck };
      const key = await hmacKey(await vault.open(rec.secret));
      return { ...draft, signature: await sign(key, envelopeText(draft)) };
    });
    const identifier = message.type === 'hello' ? ids.hello(envelope.clientId) : ids.command(message.type, envelope.clientId);
    await this.write(identifier, 'envelope', envelope);
    return envelope.counter;
  }

  /** The keys an ack of the master may be signed with: the secret and the one before the key exchange. */
  async ackKeys (vault) {
    const rec = this.paired();
    return Promise.all([rec.secret, rec.previous].filter(Boolean).map(async (s) => hmacKey(await vault.open(s))));
  }

  /**
   * The master's final ack of command `counter` ({ status, reason, payload }),
   * or { status: 'Unconfirmed' } if none came by `until`.
   */
  async waitAck (counter, until, vault) {
    const keys = await this.ackKeys(vault);
    const { clientId } = this.paired();
    for (;;) {
      const ack = (await this.read(ids.ack(clientId)))?.ack;
      if (ack && ack.clientId === clientId && ack.commandCounter === counter && ack.phase === 'Done') {
        let signed = false;
        for (const key of keys) signed ||= await verify(key, ackText(ack), ack.signature);
        if (signed) {
          await this.store.lock(async () => this.store.save({ ...this.paired(), lastAnswer: this.now() }));
          return ack;
        }
      }
      if (this.now() >= until) return { status: 'Unconfirmed' };
      await this.sleep(this.pollMs);
    }
  }

  // --- the master's settings ------------------------------------------------

  /**
   * The master's cold doc: { config (runningConfig), signedAt, verified }, or
   * null if there is none. With the master's signing key, a doc it did not
   * sign is refused (an error); without one, it is read unverified.
   */
  async masterSettings () {
    const doc = await this.read(ids.cold);
    if (!doc) return null;
    const key = this.paired()?.signingKey;
    if (typeof doc.signed !== 'string') {
      if (key) throw new ControlError('AAPS\'s settings on this server are not signed by AAPS.');
      return doc.runningConfig ? { config: doc.runningConfig, signedAt: null, verified: false } : null;
    }
    if (key && !await verifyMasterDoc(key, ids.cold, doc.signed, doc.signature)) {
      throw new ControlError('AAPS\'s settings on this server do not carry AAPS\'s signature.');
    }
    const signed = JSON.parse(doc.signed);
    return { config: signed.runningConfig || {}, signedAt: signed.signedAt ?? null, verified: !!key };
  }

  /** What the page shows: the record, and whether the master lists loopk and with which role. */
  async status () {
    const rec = this.paired();
    if (!rec) return { paired: false };
    const out = { paired: true, clientId: rec.clientId, name: rec.name, role: rec.role, replaced: rec.replaced, verified: false, listed: null, signedAt: null, lastAnswer: rec.lastAnswer };
    const master = await this.masterSettings().catch((err) => ({ error: err.message }));
    if (master?.error) return { ...out, error: master.error };
    if (!master) return { ...out, error: 'AAPS\'s settings are not on this server: is AAPS uploading here?' };
    const clients = master.config.authorizedClients;
    out.verified = master.verified;
    out.signedAt = master.signedAt;
    if (clients) {
      out.listed = clients.clientIds?.includes(rec.clientId) ?? false;
      out.role = clients.roles?.[rec.clientId] ?? out.role;
    }
    return out;
  }

  /**
   * Copies the profile `test` (the AI Test profile) into AAPS's local profile
   * `to`: reads AAPS's profiles from its signed settings, sends them back with
   * `to` replaced (or added) as a preferences update, waits for the ack, and
   * for AAPS's settings to show the profile. Returns { adds, confirmed }.
   */
  async copyProfile (test, to, vault) {
    const rec = this.paired();
    if (!rec) throw new ControlError('loopk is not paired with AAPS in this browser.', 'NotPaired');
    // A pairing whose key exchange did not finish tries again first.
    if (!rec.replaced) await this.keyExchange(vault);
    const master = await this.masterSettings();
    if (!master) throw new ControlError('AAPS\'s settings are not on this server: is AAPS uploading here?');
    const clients = master.config.authorizedClients;
    if (clients && !clients.clientIds?.includes(rec.clientId)) throw new ControlError(REASONS.NotPaired, 'NotPaired');
    const role = clients?.roles?.[rec.clientId];
    if (role && role !== 'Admin') throw new ControlError(REASONS.NotAllowedForRole, 'NotAllowedForRole');

    const current = master.config.syncedPrefs?.[PROFILE_KEY] || '';
    const { value, lastModified, adds } = profileDataWith(current, test, to, this.now());
    const validUntil = this.now() + this.roundTripMs;
    const counter = await this.send({ type: 'preferences_update', prefs: { [PROFILE_KEY]: { value, lastModified } } }, vault, { validUntil, wantsAck: true });
    const ack = await this.waitAck(counter, validUntil + this.ackMarginMs, vault);
    if (ack.status === 'Unconfirmed') throw new ControlError('AAPS did not answer. Check that the phone is online, and on the phone whether the profile arrived.', 'NoReply');
    if (ack.status === 'Expired') throw new ControlError('The change reached AAPS too late, so it was not made. Check that the phone is online and try again.', 'Expired');
    if (ack.status !== 'Ok') throw new ControlError(REASONS[ack.reason] || `AAPS refused the change (${ack.reason || ack.status}).`, ack.reason || ack.status);
    const sent = JSON.stringify(parseProfileData(value).profiles.find((p) => p.name === to));
    return { adds, confirmed: await this.profileArrived(to, sent, master.signedAt) };
  }

  /** Whether AAPS's settings, signed after `since`, show the profile `to` as `sent` (JSON) within coldWaitMs. */
  async profileArrived (to, sent, since) {
    const until = this.now() + this.coldWaitMs;
    for (;;) {
      const master = await this.masterSettings().catch(() => null);
      if (master && (since == null || master.signedAt > since)) {
        const { profiles } = parseProfileData(master.config.syncedPrefs?.[PROFILE_KEY] || '');
        return JSON.stringify(profiles.find((p) => p.name === to)) === sent;
      }
      if (this.now() >= until) return false;
      await this.sleep(this.pollMs);
    }
  }
}

/** A store in memory, for tests and for code that keeps the record elsewhere. */
export function memoryStore (initial = null) {
  let rec = initial;
  let queue = Promise.resolve();
  return {
    load: () => (rec ? structuredClone(rec) : null),
    save: (next) => { rec = next ? structuredClone(next) : null; },
    lock: (fn) => {
      const run = queue.then(fn);
      queue = run.catch(() => {});
      return run;
    },
  };
}
