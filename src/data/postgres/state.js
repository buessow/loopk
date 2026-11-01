// loopk's own state in Postgres, beside the Nightscout records: access
// (signing key, tokens, people), the server it follows, sport mode, the
// loop settings and AI Test profile entered for the simulator, report
// dashboards, and prediction models with what they predicted. Methods take
// and return epoch milliseconds where they take times; rows come back as
// the callers use them (src/data/index.js describes the interface).

import { VALID_SGV } from './records.js';

export function stateStores (pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const all = async (sql, params) => (await pool.query(sql, params)).rows;

  return {
    /** The value of server key `name`, made with `make()` and kept on first use. */
    async serverKey (name, make) {
      const row = await one(
        `INSERT INTO server_keys (name, value) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING value`, [name, make()]);
      return row.value;
    },

    // Access tokens ("subjects" in Nightscout).
    subjects: {
      list: () => all('SELECT id, name, can_write, can_upload_model, notes, access_token, created_at FROM subjects ORDER BY name'),
      create: ({ name, canWrite, canUploadModel, notes, token }) => one(
        'INSERT INTO subjects (name, can_write, can_upload_model, notes, access_token) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [name, canWrite, canUploadModel, notes, token]),
      update: (id, { name, canWrite, canUploadModel, notes }) => one(
        `UPDATE subjects SET name = coalesce($2, name), can_write = coalesce($3, can_write),
                can_upload_model = coalesce($4, can_upload_model), notes = coalesce($5, notes)
         WHERE id = $1 RETURNING *`, [id, name ?? null, canWrite ?? null, canUploadModel ?? null, notes ?? null]),
      async remove (id) {
        return (await pool.query('DELETE FROM subjects WHERE id = $1', [id])).rowCount > 0;
      },
    },

    // People who sign in to the web UI.
    users: {
      get: (email) => one('SELECT * FROM users WHERE email = $1', [email]),
      list: () => all('SELECT * FROM users ORDER BY email'),
      setAdmin: (email, isAdmin) => one(
        `INSERT INTO users (email, is_admin) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET is_admin = EXCLUDED.is_admin RETURNING *`, [email, isAdmin]),
      async remove (email) {
        return (await pool.query('DELETE FROM users WHERE email = $1', [email])).rowCount > 0;
      },
      /** Records a sign-in; an admin stays one. */
      signedIn: ({ email, name, picture, isAdmin }) => one(
        `INSERT INTO users (email, name, picture, is_admin, last_login) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, picture = EXCLUDED.picture,
           is_admin = users.is_admin OR EXCLUDED.is_admin, last_login = now()
         RETURNING *`, [email, name || null, picture || null, isAdmin]),
    },

    // The server this one follows, and up to where each collection is copied.
    follow: {
      get: () => one('SELECT * FROM follow_config'),
      async save ({ url, token, enabled, by }) {
        await pool.query(
          `INSERT INTO follow_config (id, url, token, enabled, updated_by) VALUES (true, $1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, token = EXCLUDED.token, enabled = EXCLUDED.enabled,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [url, token, enabled, by || null]);
      },
      async remove () {
        await pool.query('DELETE FROM follow_config');
      },
      cursors: () => all('SELECT collection, last_modified, source_url, updated_at FROM follow_state'),
      cursor: (collection) => one('SELECT last_modified, source_url FROM follow_state WHERE collection = $1', [collection]),
      async saveCursor (collection, lastModified, sourceUrl) {
        await pool.query(
          `INSERT INTO follow_state (collection, last_modified, source_url) VALUES ($1, $2, $3)
           ON CONFLICT (collection) DO UPDATE SET last_modified = EXCLUDED.last_modified, source_url = EXCLUDED.source_url, updated_at = now()`,
          [collection, lastModified, sourceUrl]);
      },
    },

    // Sport mode's setting.
    sport: {
      get: () => one('SELECT * FROM sport_config'),
      async save ({ percentage, duration, target, profile, by }) {
        await pool.query(
          `INSERT INTO sport_config (id, percentage, duration, target, profile, updated_by) VALUES (true, $1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET percentage = EXCLUDED.percentage, duration = EXCLUDED.duration, target = EXCLUDED.target,
             profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [percentage, duration, target, profile, by || null]);
      },
      async remove () {
        await pool.query('DELETE FROM sport_config');
      },
    },

    // Loop settings entered for the simulator, each holding from a time on.
    loopSettings: {
      /** Every row: [{ setting, value, validFrom, by, updatedAt }]. */
      async list () {
        const rows = await all('SELECT setting, value, valid_from, updated_by, updated_at FROM loop_settings ORDER BY valid_from, setting');
        return rows.map((r) => ({ setting: r.setting, value: r.value, validFrom: r.valid_from.getTime(), by: r.updated_by, updatedAt: r.updated_at.getTime() }));
      },
      /** [{ setting, value }] holding at `at`. */
      at: (at) => all(`SELECT DISTINCT ON (setting) setting, value FROM loop_settings
         WHERE valid_from <= $1 ORDER BY setting, valid_from DESC`, [new Date(at)]),
      async save (setting, value, validFrom, by) {
        await pool.query(`INSERT INTO loop_settings (setting, value, valid_from, updated_by) VALUES ($1, $2, $3, $4)
          ON CONFLICT (setting, valid_from) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [setting, JSON.stringify(value), new Date(validFrom), by]);
      },
      /** The times (ms) in (from, to] at which entered settings change. */
      async changes (from, to) {
        const rows = await all('SELECT DISTINCT valid_from FROM loop_settings WHERE valid_from > $1 AND valid_from <= $2 ORDER BY valid_from',
          [new Date(from), new Date(to)]);
        return rows.map((r) => r.valid_from.getTime());
      },
    },

    // Profiles agents write to simulate with (the "AI Test" profile).
    testProfiles: {
      get: (name) => one('SELECT * FROM test_profiles WHERE name = $1', [name]),
      async save (name, { profile, basedOn, note, by }) {
        await pool.query(
          `INSERT INTO test_profiles (name, profile, based_on, note, updated_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET profile = $2, based_on = $3, note = $4, updated_by = $5, updated_at = now()`,
          [name, profile, basedOn, note, by]);
      },
      async remove (name) {
        await pool.query('DELETE FROM test_profiles WHERE name = $1', [name]);
      },
    },

    // Report dashboards of people signed in to the web UI.
    dashboards: {
      async get (email) {
        return (await one('SELECT dashboard FROM report_dashboards WHERE email = $1', [email]))?.dashboard ?? null;
      },
      async save (email, dashboard) {
        await pool.query(
          `INSERT INTO report_dashboards (email, dashboard, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (email) DO UPDATE SET dashboard = EXCLUDED.dashboard, updated_at = now()`,
          [email, JSON.stringify(dashboard)]);
      },
    },

    // Uploaded prediction models, newest last.
    models: {
      async newestId () {
        return (await one('SELECT id FROM prediction_models ORDER BY id DESC LIMIT 1'))?.id ?? null;
      },
      get: (id) => one('SELECT id, model, uploaded_by, created_at FROM prediction_models WHERE id = $1', [id]),
      save: (model, uploadedBy) => one(
        `INSERT INTO prediction_models (version, model, uploaded_by) VALUES ($1, $2, $3)
         RETURNING id, model, uploaded_by, created_at`, [model.version, JSON.stringify(model), uploadedBy]),
    },

    // What the models predicted, per reading.
    predictions: {
      /** Times (ms) of readings after `since` without a prediction yet, oldest first. */
      async unpredicted (since) {
        const rows = await all(
          `SELECT DISTINCT date FROM entries e WHERE ${VALID_SGV} AND date > $1
              AND NOT EXISTS (SELECT 1 FROM glucose_predictions p WHERE p.made_at = e.date)
            ORDER BY date`, [new Date(since)]);
        return rows.map((r) => new Date(r.date).getTime());
      },
      /** Saves predictions ({ madeAt, minutes, date, sgv, low, high } as columns) of model `modelId`; returns how many were new. */
      async save (out, modelId) {
        const { rowCount } = await pool.query(
          `INSERT INTO glucose_predictions (made_at, minutes, date, sgv, low, high, model_id)
           SELECT *, $7::bigint FROM unnest($1::timestamptz[], $2::smallint[], $3::timestamptz[], $4::real[], $5::real[], $6::real[])
           ON CONFLICT DO NOTHING`,
          [out.madeAt, out.minutes, out.date, out.sgv, out.low, out.high, modelId]);
        return rowCount;
      },
      /** Predictions for from <= date < to (ms), oldest first. */
      between: (from, to) => all(
        `SELECT made_at, minutes, date, sgv, low, high FROM glucose_predictions
          WHERE date >= $1 AND date < $2 ORDER BY date, minutes`, [new Date(from), new Date(to)]),
    },
  };
}
