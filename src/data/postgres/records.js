// The Nightscout records (glucose, treatments, device status, profiles,
// heart rate) as loopk's features read them from Postgres: each method
// covers a stated time range (epoch ms), so another source can tell what it
// must have loaded. Rows come back as the callers use them, dates as the
// driver returns them unless a method says otherwise.

import { SGV_MAX, SGV_MIN, SIMULATED_SOURCES } from '../../predict/index.js';

/** SQL condition for the entries that are glucose readings the model uses. */
export const VALID_SGV = `type = 'sgv' AND sgv BETWEEN ${SGV_MIN} AND ${SGV_MAX} AND date IS NOT NULL AND is_valid IS DISTINCT FROM false`
  + ` AND coalesce(device, '') NOT IN (${SIMULATED_SOURCES.map((d) => `'${d}'`).join(', ')})`;

const VALID = 'is_valid IS DISTINCT FROM false';
const ms = (d) => new Date(d).getTime();
const schedule = () => `json_agg(json_build_array(coalesce(s.seconds, extract(epoch FROM s.time::time)::int), s.value) ORDER BY s.position)`;

// --- glucose --------------------------------------------------------------------

const HOURLY_GLUCOSE = `
  SELECT floor(extract(epoch FROM date) / 3600)::float8 AS h, count(*)::int AS n,
         sum(sgv)::float8 AS s, sum(sgv::float8 * sgv) AS ss,
         count(*) FILTER (WHERE sgv < 54)::int AS very_low,
         count(*) FILTER (WHERE sgv >= 54 AND sgv < 70)::int AS low,
         count(*) FILTER (WHERE sgv >= 70 AND sgv <= 180)::int AS target,
         count(*) FILTER (WHERE sgv > 180 AND sgv <= 250)::int AS high,
         count(*) FILTER (WHERE sgv > 250)::int AS very_high
    FROM entries
   WHERE ${VALID_SGV} AND date >= $1 AND date < $2
   GROUP BY 1`;

// --- treatments -------------------------------------------------------------------

// The treatments the prediction model uses, as modelling/glupred/load.py
// reads them, for from <= date < to ($1, $2); stored profiles before `to` ($1).
const MODEL_TREATMENTS = {
  boluses: `SELECT date, insulin::float8 AS insulin FROM treatments
     WHERE insulin > 0 AND date >= $1 AND date < $2 AND ${VALID}
       AND coalesce(type, '') NOT IN ('PRIMING', 'FAKE_EXTENDED') AND coalesce(event_type, '') <> 'Combo Bolus'
     ORDER BY date`,
  // Extended boluses on top of the basal; those a FAKE_EXTENDED temp basal
  // emulates are part of its rate.
  extended: `SELECT c.date, c.entered_insulin::float8 AS insulin, c.duration::float8 AS duration FROM treatments c
     WHERE c.event_type = 'Combo Bolus' AND c.entered_insulin > 0 AND c.duration > 0
       AND c.date >= $1 AND c.date < $2 AND c.${VALID}
       AND NOT coalesce(c.is_emulating_temp_basal, false)
       AND NOT EXISTS (SELECT 1 FROM treatments f
                        WHERE f.type = 'FAKE_EXTENDED' AND f.extended_emulated->>'identifier' = c.identifier
                          AND f.date BETWEEN c.date - interval '1 day' AND c.date + interval '1 day')
     ORDER BY c.date`,
  tempBasals: `SELECT date, coalesce(duration_in_milliseconds, duration * 60000)::float8 AS duration_ms,
       coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent FROM treatments
     WHERE event_type = 'Temp Basal' AND date >= $1 AND date < $2 AND ${VALID}
     ORDER BY date`,
  carbs: `SELECT date, carbs::float8 AS carbs FROM treatments
     WHERE carbs > 0 AND date >= $1 AND date < $2 AND ${VALID}
     ORDER BY date`,
  // From the last permanent switch before the window: it sets the profile
  // that the later ones go back to.
  profileSwitches: `SELECT t.date, t.profile, coalesce(t.percentage, 100)::float8 AS percentage,
       coalesce(t.timeshift, 0)::float8 AS timeshift, coalesce(t.duration, 0)::float8 AS duration,
       (SELECT ${schedule()} FROM treatment_profile_schedules s
         WHERE s.treatment_identifier = t.identifier AND s.kind = 'basal') AS schedule
     FROM treatments t
     WHERE t.event_type = 'Profile Switch' AND t.date < $2 AND t.${VALID}
       AND t.date >= coalesce((SELECT max(date) FROM treatments WHERE event_type = 'Profile Switch'
                                  AND coalesce(duration, 0) = 0 AND date <= $1 AND ${VALID}), '-infinity')
     ORDER BY t.date`,
  profileStores: `SELECT p.date, p.default_profile, s.name, ${schedule()} AS schedule
     FROM profile p JOIN profile_store_schedules s ON s.profile_identifier = p.identifier
     WHERE s.kind = 'basal' AND p.date IS NOT NULL AND p.date < $1 AND p.${VALID}
     GROUP BY p.identifier, p.date, p.default_profile, s.name
     ORDER BY p.date`,
};

const MODEL_ROWS = {
  boluses: (r) => ({ date: ms(r.date), insulin: r.insulin }),
  extended: (r) => ({ date: ms(r.date), insulin: r.insulin, duration: r.duration }),
  tempBasals: (r) => ({ date: ms(r.date), durationMs: r.duration_ms, rate: r.rate, percent: r.percent }),
  carbs: (r) => ({ date: ms(r.date), carbs: r.carbs }),
  profileSwitches: (r) => ({
    date: ms(r.date), profile: r.profile, percentage: r.percentage, timeshift: r.timeshift, duration: r.duration, schedule: r.schedule,
  }),
  profileStores: (r) => ({ date: ms(r.date), defaultProfile: r.default_profile, name: r.name, schedule: r.schedule }),
};

// --- the loop's runs (devicestatus) --------------------------------------------------

const RUNS = `SELECT identifier, date,
     coalesce(enacted_bg, suggested_bg)::float8 AS bg,
     coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg,
     coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
     coalesce(enacted_insulin_req, suggested_insulin_req)::float8 AS insulin_req,
     coalesce(enacted_carbs_req, suggested_carbs_req)::float8 AS carbs_req,
     coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob,
     iob_basaliob::float8 AS basal_iob,
     coalesce(enacted_cob, suggested_cob)::float8 AS cob,
     coalesce(enacted_sensitivity_ratio, suggested_sensitivity_ratio)::float8 AS sensitivity_ratio,
     coalesce(enacted_variable_sens, suggested_variable_sens)::float8 AS isf,
     coalesce(enacted_rate, suggested_rate)::float8 AS rate,
     coalesce(enacted_duration, suggested_duration)::float8 AS duration,
     coalesce(enacted_units, suggested_units)::float8 AS smb,
     enacted_smb::float8 AS smb_given,
     coalesce(enacted_algorithm, suggested_algorithm) AS algorithm,
     coalesce(enacted_running_dynamic_isf, suggested_running_dynamic_isf) AS dynamic_isf,
     (enacted_reason IS NOT NULL OR enacted_bg IS NOT NULL) AS enacted,
     coalesce(enacted_reason, suggested_reason) AS reason,
     CASE WHEN $3 THEN coalesce(enacted_console_error, suggested_console_error) END AS console_error,
     CASE WHEN $3 THEN coalesce(enacted_console_log, suggested_console_log) END AS console_log
   FROM devicestatus
   WHERE date >= $1 AND date < $2 AND ${VALID}
     AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL OR suggested_reason IS NOT NULL)
   ORDER BY date`;

const MISS_RUNS = `SELECT date,
     coalesce(enacted_bg, suggested_bg)::float8 AS bg,
     coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg,
     coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
     coalesce(enacted_insulin_req, suggested_insulin_req)::float8 AS insulin_req,
     coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob,
     coalesce(enacted_cob, suggested_cob)::float8 AS cob,
     coalesce(enacted_variable_sens, suggested_variable_sens)::float8 AS isf,
     coalesce(enacted_reason, suggested_reason) AS reason`;

const CONFIGURATION = `SELECT date, configuration_aps AS aps, configuration_sensitivity AS sensitivity,
     configuration_insulin AS insulin, configuration_version AS version,
     aps_configuration AS aps_settings, sensitivity_configuration AS sensitivity_settings,
     insulin_configuration AS insulin_settings, safety_configuration AS safety_settings
   FROM devicestatus
   WHERE date <= $1 AND ${VALID} AND configuration_aps IS NOT NULL
   ORDER BY date DESC NULLS LAST LIMIT 1`;

// --- profiles ------------------------------------------------------------------------

// The profile of the newest switch with an embedded profile at or before a
// time, and the default profile of the newest stored profile.
const SWITCH_PROFILE = `SELECT t.date, t.profile AS name, p.dia::float8 AS dia, p.units, p.timezone,
     t.percentage::float8 AS percentage, t.timeshift::float8 AS timeshift,
     (SELECT json_object_agg(kind, v) FROM (
        SELECT kind, json_agg(json_build_array(coalesce(seconds, extract(epoch FROM time::time)::int), value) ORDER BY position) AS v
        FROM treatment_profile_schedules s WHERE s.treatment_identifier = t.identifier GROUP BY kind) k) AS schedules
   FROM treatments t JOIN treatment_profiles p ON p.treatment_identifier = t.identifier
   WHERE t.event_type IN ('Profile Switch', 'Effective Profile Switch') AND t.date <= $1 AND t.${VALID}
   ORDER BY t.date DESC LIMIT 1`;

const STORE_PROFILE = `SELECT p.date, s.name, s.dia::float8 AS dia, coalesce(s.units, p.units) AS units, s.timezone,
     (SELECT json_object_agg(kind, v) FROM (
        SELECT kind, json_agg(json_build_array(coalesce(seconds, extract(epoch FROM time::time)::int), value) ORDER BY position) AS v
        FROM profile_store_schedules c WHERE c.profile_identifier = s.profile_identifier AND c.name = s.name GROUP BY kind) k) AS schedules
   FROM profile p JOIN profile_stores s ON s.profile_identifier = p.identifier AND s.name = p.default_profile
   WHERE p.date <= $1 AND p.${VALID}
   ORDER BY p.date DESC LIMIT 1`;

// --- the replay's history (src/oref/inputs.js) -------------------------------------------

// Effective profile switches (AAPS uploads them as notes with the profile)
// from the last one at or before $1 to $2.
const SINCE_LAST_EPS = `t.date <= $2 AND t.date >= coalesce((SELECT max(date) FROM treatments
            WHERE event_type = 'Note' AND original_profile_name IS NOT NULL AND date <= $1 AND ${VALID}), '-infinity')`;

export function recordStores (pool) {
  const all = async (sql, params) => (await pool.query(sql, params)).rows;
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const range = (from, to) => [new Date(from), new Date(to)];

  return {
    glucose: {
      /** Date (ms) of the first reading, or null. */
      async first () {
        const r = await one(`SELECT min(date) AS date FROM entries WHERE ${VALID_SGV}`);
        return r.date ? ms(r.date) : null;
      },
      /** Date (ms) of the newest reading, or null. */
      async newest () {
        const r = await one(`SELECT max(date) AS date FROM entries WHERE ${VALID_SGV}`);
        return r.date ? ms(r.date) : null;
      },
      /** Readings { date, sgv, utc_offset } with from <= date <= to, oldest first. */
      upTo: (from, to) => all(`SELECT date, sgv, utc_offset FROM entries WHERE ${VALID_SGV} AND date >= $1 AND date <= $2 ORDER BY date`, range(from, to)),
      /** Readings { date, sgv, direction } with from <= date < to, oldest first. */
      between: (from, to) => all(`SELECT date, sgv::float8 AS sgv, direction FROM entries WHERE ${VALID_SGV} AND date >= $1 AND date < $2 ORDER BY date`, range(from, to)),
      /** The `n` newest readings at or before `at`, newest first. */
      latest: (at, n) => all(`SELECT date, sgv::float8 AS sgv, direction FROM entries WHERE ${VALID_SGV} AND date <= $1 ORDER BY date DESC NULLS LAST LIMIT $2`, [new Date(at), n]),
      /** Per UTC hour h in [from, to): readings, sum, sum of squares and counts by range (mg/dL). */
      hourly: (from, to) => all(HOURLY_GLUCOSE, range(from, to)),
      /** Times (ms) of every reading AAPS had in [from, to), deleted and simulated ones too. */
      async allTimes (from, to) {
        const rows = await all(`SELECT date FROM entries WHERE type = 'sgv' AND date >= $1 AND date < $2 ORDER BY date`, range(from, to));
        return rows.map((r) => ms(r.date));
      },
      /** Readings { date, sgv, device } in [from, to], those of `excludeDevices` left out, for the replay. */
      forReplay: (from, to, excludeDevices) => all(`SELECT date, sgv::float8 AS sgv, device FROM entries
        WHERE type = 'sgv' AND sgv IS NOT NULL AND date >= $1 AND date <= $2 AND ${VALID}
          AND NOT (coalesce(device, '') = ANY($3))
        ORDER BY date`, [...range(from, to), excludeDevices]),
    },

    treatments: {
      /**
       * Treatments with from <= date < to as the prediction model takes them
       * (dates in ms); profile switches from the last permanent one before,
       * stored profiles before `to`.
       */
      async forModel (from, to) {
        const entries = await Promise.all(Object.entries(MODEL_TREATMENTS).map(async ([key, sql]) => {
          const params = key === 'profileStores' ? [new Date(to)] : range(from, to);
          return [key, (await all(sql, params)).map(MODEL_ROWS[key])];
        }));
        return Object.fromEntries(entries);
      },
      /** Insulin and carbs { date, insulin, carbs, smb } in [from, to), for the misses. */
      forMisses: (from, to) => all(`SELECT date, insulin::float8 AS insulin, carbs::float8 AS carbs,
           coalesce(type = 'SMB' OR is_smb, false) AS smb
         FROM treatments
         WHERE date >= $1 AND date < $2 AND ${VALID} AND (insulin > 0 OR carbs > 0)
           AND coalesce(type, '') <> 'PRIMING'
         ORDER BY date`, range(from, to)),
      /** Every treatment in [from, to) but primings, with the fields the MCP tools show. */
      between: (from, to) => all(`SELECT date, event_type, type, is_smb, insulin::float8 AS insulin, carbs::float8 AS carbs,
           protein::float8 AS protein, fat::float8 AS fat,
           coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes,
           coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent,
           target_bottom::float8 AS target_bottom, target_top::float8 AS target_top,
           profile, percentage::float8 AS percentage, timeshift::float8 AS timeshift, reason, notes, entered_by
         FROM treatments
         WHERE date >= $1 AND date < $2 AND ${VALID} AND coalesce(type, '') <> 'PRIMING'
         ORDER BY date`, range(from, to)),
      /** The newest temp basal at or before `at`: { date, rate, minutes }. */
      latestTempBasal: (at) => one(`SELECT date, coalesce(absolute, rate)::float8 AS rate, coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes
        FROM treatments WHERE event_type = 'Temp Basal' AND date <= $1 AND ${VALID} ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(at)]),
      /** The newest temp target at or before `at`: { date, bottom, top, reason, minutes }. */
      latestTempTarget: (at) => one(`SELECT date, target_bottom::float8 AS bottom, target_top::float8 AS top, reason,
          coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes
        FROM treatments WHERE event_type = 'Temporary Target' AND date <= $1 AND ${VALID} ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(at)]),
      /**
       * The treatments the replay needs in [from, to] (src/oref/inputs.js):
       * boluses, temps, carbs, temp targets, site changes and profile
       * switches; effective profile switches (eps, with their schedules)
       * from the last one at or before `from`.
       */
      async forReplay (from, to) {
        const q = (sql) => all(sql, range(from, to));
        const [boluses, temps, carbs, eps, schedules, targets, events] = await Promise.all([
          q(`SELECT date, insulin::float8 AS insulin, (type = 'SMB' OR coalesce(is_smb, false)) AS smb FROM treatments
              WHERE insulin > 0 AND date >= $1 AND date <= $2 AND ${VALID}
                AND coalesce(type, '') NOT IN ('PRIMING', 'FAKE_EXTENDED') AND coalesce(event_type, '') <> 'Combo Bolus'
              ORDER BY date`),
          q(`SELECT date, coalesce(duration_in_milliseconds, duration * 60000)::float8 AS duration_ms,
                coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent, srv_created, utc_offset FROM treatments
              WHERE event_type = 'Temp Basal' AND date >= $1 AND date <= $2 AND ${VALID}
              ORDER BY date`),
          q(`SELECT date, carbs::float8 AS carbs, srv_created FROM treatments
              WHERE carbs > 0 AND date >= $1 AND date <= $2 AND ${VALID} ORDER BY date`),
          q(`SELECT t.identifier, t.date, t.original_profile_name AS name, coalesce(t.original_percentage, 100)::float8 AS percentage, p.dia::float8 AS dia, p.units, p.timezone
              FROM treatments t JOIN treatment_profiles p ON p.treatment_identifier = t.identifier
              WHERE t.event_type = 'Note' AND t.original_profile_name IS NOT NULL AND t.${VALID}
                AND ${SINCE_LAST_EPS}
              ORDER BY t.date`),
          q(`SELECT s.treatment_identifier AS id, s.kind, coalesce(s.seconds, extract(epoch FROM s.time::time)::int) AS seconds, s.value::float8 AS value
              FROM treatment_profile_schedules s JOIN treatments t ON t.identifier = s.treatment_identifier
              WHERE t.event_type = 'Note' AND t.original_profile_name IS NOT NULL AND ${SINCE_LAST_EPS}
              ORDER BY s.treatment_identifier, s.kind, s.position`),
          q(`SELECT date, coalesce(duration, 0)::float8 AS duration, target_bottom::float8 AS low, target_top::float8 AS high, units
              FROM treatments WHERE event_type = 'Temporary Target' AND date >= $1 AND date <= $2 AND ${VALID} ORDER BY date`),
          q(`SELECT date, event_type, coalesce(duration, 0)::float8 AS duration FROM treatments
              WHERE event_type IN ('Site Change', 'Profile Switch') AND date >= $1 AND date <= $2 AND ${VALID} ORDER BY date`),
        ]);
        return { boluses, temps, carbs, eps, schedules, targets, events };
      },
    },

    loop: {
      /** The loop's runs in [from, to), their console output with `withConsole`. */
      runs: (from, to, withConsole = false) => all(RUNS, [...range(from, to), withConsole]),
      /** The runs in [from, to) the misses weigh. */
      forMisses: (from, to) => all(`${MISS_RUNS}
         FROM devicestatus
         WHERE date >= $1 AND date < $2 AND ${VALID}
           AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL)
         ORDER BY date`, range(from, to)),
      /** The runs in [from, to], one per run time, as the replay takes them. */
      forReplay: (from, to) => all(`SELECT DISTINCT ON (suggested_deliver_at) date, suggested_deliver_at AS deliver_at,
          suggested_algorithm AS algorithm, suggested_running_dynamic_isf AS dynamic_isf,
          suggested_bg::float8 AS bg, suggested_eventual_bg::float8 AS eventual_bg, suggested_target_bg::float8 AS target_bg,
          suggested_insulin_req::float8 AS insulin_req, suggested_carbs_req::float8 AS carbs_req,
          suggested_cob::float8 AS cob, suggested_iob::float8 AS iob, suggested_rate::float8 AS rate,
          suggested_duration::float8 AS duration, suggested_units::float8 AS units,
          suggested_sensitivity_ratio::float8 AS sensitivity_ratio, suggested_variable_sens::float8 AS variable_sens,
          suggested_tick AS tick, suggested_reason AS reason,
          coalesce(suggested_console_error, '{}') AS console_error, coalesce(suggested_console_log, '{}') AS console_log,
          configuration_version AS version
        FROM devicestatus
        WHERE date >= $1 AND date <= $2 AND ${VALID} AND suggested_bg IS NOT NULL AND suggested_deliver_at IS NOT NULL
        ORDER BY suggested_deliver_at, date`, range(from, to)),
      /** The newest run at or before `at`: { date, iob, cob, eventual_bg, target_bg, algorithm, reason }. */
      latest: (at) => one(`SELECT date, coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob, coalesce(enacted_cob, suggested_cob)::float8 AS cob,
          coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg, coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
          coalesce(enacted_algorithm, suggested_algorithm) AS algorithm, coalesce(enacted_reason, suggested_reason) AS reason
        FROM devicestatus WHERE date <= $1 AND ${VALID} AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL) ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(at)]),
      /** The newest configuration AAPS uploaded at or before `at`, or null. */
      configuration: (at) => one(CONFIGURATION, [new Date(at)]),
      /** The predicted curves of runs `ids`, enacted ones before suggested ones. */
      curves: (ids) => all(`SELECT devicestatus_identifier AS id, source, curve, "values"
         FROM devicestatus_predictions WHERE devicestatus_identifier = ANY($1)
         ORDER BY CASE source WHEN 'enacted' THEN 0 ELSE 1 END`, [ids]),
      /** Sensitivity ratios { date, ratio } of the runs in [from, to). */
      sensitivityRatios: (from, to) => all(`SELECT date, suggested_sensitivity_ratio::float8 AS ratio FROM devicestatus
         WHERE suggested_sensitivity_ratio > 0 AND date >= $1 AND date < $2 AND ${VALID}
         ORDER BY date`, range(from, to)),
      /** Up to 2000 reasons in (from, to] that name a limit (max_iob, maxSafeBasal), newest first. */
      limitReasons: (from, to) => all(`SELECT suggested_reason AS reason FROM devicestatus
         WHERE date > $1 AND date <= $2 AND suggested_reason ~ 'max_iob [1-9]|maxSafeBasal' AND ${VALID}
         ORDER BY date DESC LIMIT 2000`, range(from, to)),
    },

    profiles: {
      /** The newest profile switch with an embedded profile at or before `at`, or null. */
      switchedAt: (at) => one(SWITCH_PROFILE, [new Date(at)]),
      /** The default profile of the newest stored profile at or before `at`, or null. */
      storedAt: (at) => one(STORE_PROFILE, [new Date(at)]),
      /**
       * The latest switch to each profile in the year before `at`, newest
       * first, as rows { name, date, percentage, dia, units, kind, seconds, value }.
       */
      switchedInYear: (at) => all(`WITH latest AS (
          SELECT DISTINCT ON (t.original_profile_name) t.identifier, t.original_profile_name AS name, t.date,
            coalesce(t.original_percentage, 100)::float8 AS percentage
          FROM treatments t
          WHERE t.event_type = 'Note' AND t.original_profile_name IS NOT NULL AND t.is_valid IS DISTINCT FROM false
            AND t.date <= $1 AND t.date > $1::timestamptz - interval '365 days'
          ORDER BY t.original_profile_name, t.date DESC)
        SELECT l.name, l.date, l.percentage, p.dia::float8 AS dia, p.units, s.kind,
          coalesce(s.seconds, extract(epoch FROM s.time::time)::int) AS seconds, s.value::float8 AS value
        FROM latest l JOIN treatment_profiles p ON p.treatment_identifier = l.identifier
          JOIN treatment_profile_schedules s ON s.treatment_identifier = l.identifier
        ORDER BY l.date DESC, s.kind, s.position`, [new Date(at)]),
      /**
       * Each profile's latest version in the profile stores at or before
       * `at`, newest first, as rows { name, dia, units, kind, seconds, value }.
       */
      storedLatest: (at) => all(`WITH latest AS (
          SELECT DISTINCT ON (s.name) s.profile_identifier, s.name, s.dia, s.units, p.date
          FROM profile p JOIN profile_stores s ON s.profile_identifier = p.identifier
          WHERE p.date <= $1 AND p.is_valid IS DISTINCT FROM false
          ORDER BY s.name, p.date DESC)
        SELECT l.name, l.dia::float8 AS dia, l.units, c.kind,
          coalesce(c.seconds, extract(epoch FROM c.time::time)::int) AS seconds, c.value::float8 AS value
        FROM latest l JOIN profile_store_schedules c ON c.profile_identifier = l.profile_identifier AND c.name = l.name
        ORDER BY l.date DESC, l.name, c.kind, c.position`, [new Date(at)]),
    },

    heartrate: {
      /** Readings { date, bpm } in [from, to) from 25 to 250 bpm. */
      between: (from, to) => all(`SELECT date, beats_per_minute::float8 AS bpm FROM heartrate
         WHERE date >= $1 AND date < $2 AND ${VALID} AND beats_per_minute BETWEEN 25 AND 250 ORDER BY date`, range(from, to)),
      /** Per UTC hour h in [from, to): readings n and their sum s (bpm). */
      hourly: (from, to) => all(`
        SELECT floor(extract(epoch FROM date) / 3600)::float8 AS h, count(*)::int AS n, sum(beats_per_minute)::float8 AS s
          FROM heartrate
         WHERE date >= $1 AND date < $2 AND beats_per_minute BETWEEN 25 AND 250 AND is_valid IS DISTINCT FROM false
         GROUP BY 1`, range(from, to)),
      /** The newest reading at or before `at`: { date, bpm }. */
      latest: (at) => one(`SELECT date, beats_per_minute::float8 AS bpm FROM heartrate WHERE date <= $1 AND ${VALID} ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(at)]),
    },
  };
}
