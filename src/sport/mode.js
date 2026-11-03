// Sport mode: an admin sets a profile percentage, a duration and an Activity
// temp target on the Access page; the glucose page switches it on and off.
// Switching writes a Profile Switch and a Temporary Target to treatments as
// AAPS uploads them, and AAPS applies them when it receives them (NSClient:
// receive profile switches and temp targets). Without Node's modules, so the
// browser runs it over Nightscout too (public/localapi.js).

const MIN = 60000;
const APP = 'loopk';
// The device of the treatments that switch sport mode on (the API keeps a
// document's device, while uploaders may rewrite its notes).
const DEVICE = 'loopk-sport';
const NOTE = 'Sport mode';
const ENDED = 'Sport mode ended';
const PCT_SUFFIX = / \(\d+%\)$/;

export const LIMITS = {
  percentage: [10, 200],
  duration: [10, 720], // minutes, or 0: until ended
  target: [72, 216], // mg/dL, 4–12 mmol/L
};

const isSport = (t) => t.device === DEVICE;
const minutes = (t) => (t.durationInMilliseconds != null ? t.durationInMilliseconds / MIN : Number(t.duration) || 0);
const end = (t) => (minutes(t) > 0 ? t.date + minutes(t) * MIN : Infinity);
const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
const validDuration = (d) => Number.isInteger(d) && (d === 0 || inRange(d, LIMITS.duration));
const DURATION_ERROR = `The duration must be ${LIMITS.duration.join(' to ')} minutes, or 0 for no limit`;
// AAPS has no temp target without an end (duration 0 ends one): with no
// limit, the temp target lasts this long, or until sport mode is ended.
export const TARGET_NO_LIMIT = 24 * 60;

/**
 * The switch that sport mode replaces: the newest one before `now` that is
 * not sport mode's and still applies (permanent, or temporary and running).
 */
export function baseSwitch (switches, now) {
  for (const s of switches) {
    if (s.date > now || isSport(s)) continue;
    if (end(s) > now) return s;
  }
  return null;
}

export class SportMode {
  constructor (ctx) {
    this.ctx = ctx;
    this.data = ctx.data;
    this.treatments = ctx.data.collection('treatments');
    this.profiles = ctx.data.collection('profile');
    this.config = null; // { percentage, duration, target, profile, updatedAt, updatedBy }
  }

  get configured () {
    return Boolean(this.config);
  }

  async load () {
    const r = await this.data.sport.get();
    this.config = r
      ? { percentage: r.percentage, duration: r.duration, target: r.target, profile: r.profile, updatedAt: r.updated_at, updatedBy: r.updated_by }
      : null;
  }

  /** { percentage, duration (min, 0: until ended), target (mg/dL or null), profile (store name or null: the one in use) }; throws a readable error. */
  async configure ({ percentage, duration, target = null, profile = null }, by) {
    if (!Number.isInteger(percentage) || !inRange(percentage, LIMITS.percentage)) throw new Error(`The percentage must be a whole number from ${LIMITS.percentage.join(' to ')}`);
    if (!validDuration(duration)) throw new Error(DURATION_ERROR);
    if (target != null && !inRange(target, LIMITS.target)) throw new Error(`The temp target must be ${LIMITS.target.join(' to ')} mg/dL (4 to 12 mmol/L)`);
    if (profile != null) {
      if (typeof profile !== 'string' || !(await this.store())?.store?.[profile]) throw new Error(`There is no profile ${profile} in the profile store`);
    }
    await this.data.sport.save({ percentage, duration, target, profile, by });
    await this.load();
  }

  async remove () {
    await this.data.sport.remove();
    await this.load();
  }

  /** The newest profile store document. */
  async store () {
    const [doc] = await this.profiles.findMany({ sort: { date: -1 }, limit: 1, onlyValid: true });
    return doc || null;
  }

  /** For admins: the setting and the profiles it may name. */
  async view () {
    const store = await this.store();
    return {
      config: this.config,
      profiles: Object.keys(store?.store || {}),
      units: store?.units || null,
      limits: LIMITS,
    };
  }

  async recent (eventType, now) {
    return this.treatments.findMany({
      filter: [{ field: 'eventType', operator: 'eq', value: eventType }, { field: 'date', operator: 'lte', value: now }],
      sort: { date: -1 },
      limit: 50,
      onlyValid: true,
    });
  }

  /**
   * Whether sport mode is on: the newest profile switch is sport mode's and
   * still running. { configured, active, from, until, profile, percentage, target }.
   */
  async state (now = Date.now()) {
    const [switches, targets] = await Promise.all([this.recent('Profile Switch', now), this.recent('Temporary Target', now)]);
    const s = switches[0];
    const t = targets[0];
    const active = Boolean(s && isSport(s) && end(s) > now);
    const target = t && isSport(t) && end(t) > now ? t.targetBottom : null;
    return {
      configured: this.configured,
      config: this.config && { percentage: this.config.percentage, duration: this.config.duration, target: this.config.target, profile: this.config.profile },
      active,
      from: active ? s.date : null,
      // null while it runs until ended.
      until: active && Number.isFinite(end(s)) ? end(s) : null,
      profile: active ? s.originalProfileName : null,
      percentage: active ? s.percentage : null,
      target,
    };
  }

  /** The profile to switch to: { name, profileJson, timeshift }, or null if none is known. */
  async profileFor (switches, now) {
    if (this.config.profile) {
      const p = (await this.store())?.store?.[this.config.profile];
      return p ? { name: this.config.profile, profileJson: JSON.stringify(p), timeshift: 0 } : null;
    }
    const base = baseSwitch(switches, now);
    if (!base?.profileJson) return null;
    return { name: base.originalProfileName || String(base.profile).replace(PCT_SUFFIX, ''), profileJson: base.profileJson, timeshift: base.timeshift || 0 };
  }

  /** Switches sport mode on for `duration` minutes, 0 until ended (the configured duration if omitted). */
  async start ({ duration, utcOffset = 0, by }, now = Date.now()) {
    if (!this.config) throw new SportError(409, 'Sport mode is not set up: an admin can set it up on the Access page');
    duration = duration ?? this.config.duration;
    if (!validDuration(duration)) throw new SportError(400, DURATION_ERROR);
    const switches = await this.recent('Profile Switch', now);
    const p = await this.profileFor(switches, now);
    if (!p) throw new SportError(409, 'The profile in use is not known: no profile switch with its profile has been uploaded');
    const pct = this.config.percentage;
    const common = { date: now, utcOffset, app: APP, device: DEVICE, enteredBy: by, notes: NOTE, isValid: true };
    const docs = [{
      ...common,
      eventType: 'Profile Switch',
      profile: pct === 100 ? p.name : `${p.name} (${pct}%)`,
      originalProfileName: p.name,
      percentage: pct,
      timeshift: p.timeshift,
      duration,
      durationInMilliseconds: duration * MIN,
      originalDuration: duration * MIN,
      profileJson: p.profileJson,
    }];
    if (this.config.target != null) docs.push({ ...common, ...tempTarget(this.config.target, duration || TARGET_NO_LIMIT) });
    await this.write(docs);
    return this.state(now);
  }

  /** Ends sport mode: back to the switch it replaced, and the temp target ended. */
  async stop ({ utcOffset = 0, by }, now = Date.now()) {
    const [switches, targets] = await Promise.all([this.recent('Profile Switch', now), this.recent('Temporary Target', now)]);
    const s = switches[0];
    const t = targets[0];
    const common = { date: now, utcOffset, app: APP, device: APP, enteredBy: by, notes: ENDED, isValid: true };
    const docs = [];
    if (s && isSport(s) && end(s) > now) {
      const base = baseSwitch(switches, now);
      // A temporary switch from before keeps its end; else back to the profile at 100%.
      const left = base && minutes(base) > 0 ? Math.max(1, Math.round((end(base) - now) / MIN)) : 0;
      const name = base ? base.originalProfileName || String(base.profile).replace(PCT_SUFFIX, '') : s.originalProfileName;
      const pct = base?.percentage ?? 100;
      docs.push({
        ...common,
        eventType: 'Profile Switch',
        profile: pct === 100 ? name : `${name} (${pct}%)`,
        originalProfileName: name,
        percentage: pct,
        timeshift: base ? base.timeshift || 0 : s.timeshift || 0,
        duration: left,
        durationInMilliseconds: left * MIN,
        originalDuration: left * MIN,
        profileJson: base?.profileJson || s.profileJson,
      });
    }
    // A temp target of duration 0 ends the running one.
    if (t && isSport(t) && end(t) > now) docs.push({ ...common, ...tempTarget(t.targetBottom, 0) });
    if (!docs.length) throw new SportError(409, 'Sport mode is not on');
    await this.write(docs);
    return this.state(now);
  }

  /**
   * Stores treatments as APIv3 would and tells the sockets (AAPS) about them.
   * A source over Nightscout writes them there, which makes the identifiers.
   */
  async write (docs) {
    if (this.ctx.follower) throw new SportError(409, `This server follows ${this.ctx.follower.url} and accepts no changes`);
    // Loaded here: API v3's identifiers need uuid, which the browser does not load.
    const { resolveIdentifier } = this.data.upstream ? {} : await import('../api3/tools.js');
    for (const doc of docs) {
      doc.created_at = new Date(doc.date).toISOString();
      doc.srvCreated = doc.srvModified = Date.now();
      resolveIdentifier?.(doc);
      const stored = await this.treatments.insert(doc);
      this.ctx.bus?.emit('storage-socket-create', { colName: 'treatments', doc: stored });
      this.ctx.bus?.emit('data-received', { colName: 'treatments' });
    }
  }
}

function tempTarget (mgdl, duration) {
  return {
    eventType: 'Temporary Target',
    reason: 'Activity',
    targetBottom: mgdl,
    targetTop: mgdl,
    units: 'mg/dl',
    duration,
    durationInMilliseconds: duration * MIN,
  };
}

export class SportError extends Error {
  constructor (status, message) {
    super(message);
    this.status = status;
  }
}
