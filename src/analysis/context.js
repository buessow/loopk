// The records a review of the loop needs for a time window: readings,
// treatments and loop runs from some time before it (insulin and carbs still
// acting) to some time after it (what came of the loop's decisions), the
// profile in effect, and the loop's configuration.

import { VALID_SGV } from '../predict/index.js';

const MIN = 60000;
const HOUR = 60 * MIN;
// Insulin given up to this long before the window still acts in it.
export const BEFORE = 6 * HOUR;
// Long enough to see where glucose went after the window's decisions.
export const AFTER = 3 * HOUR;
// Selections up to this long; the loop's console log is sent for all of it.
export const MAX_WINDOW = 12 * HOUR;

const VALID = 'is_valid IS DISTINCT FROM false';
const ms = (d) => (d == null ? null : new Date(d).getTime());

const READINGS = `SELECT date, sgv::float8 AS sgv, direction FROM entries
   WHERE ${VALID_SGV} AND date >= $1 AND date < $2 ORDER BY date`;

const TREATMENTS = `SELECT date, event_type, type, is_smb, insulin::float8 AS insulin, carbs::float8 AS carbs,
     protein::float8 AS protein, fat::float8 AS fat,
     coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes,
     coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent,
     target_bottom::float8 AS target_bottom, target_top::float8 AS target_top, units,
     profile, percentage::float8 AS percentage, timeshift::float8 AS timeshift,
     glucose::float8 AS glucose, reason, notes
   FROM treatments
   WHERE date >= $1 AND date < $2 AND ${VALID} AND coalesce(type, '') <> 'PRIMING'
   ORDER BY date`;

// One row per loop run: what it was told (enacted) or, when it set nothing,
// what it suggested.
const RUNS = `SELECT date,
     coalesce(enacted_bg, suggested_bg)::float8 AS bg,
     coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg,
     coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
     coalesce(enacted_insulin_req, suggested_insulin_req)::float8 AS insulin_req,
     coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob,
     iob_basaliob::float8 AS basal_iob,
     coalesce(enacted_cob, suggested_cob)::float8 AS cob,
     coalesce(enacted_sensitivity_ratio, suggested_sensitivity_ratio)::float8 AS sensitivity_ratio,
     coalesce(enacted_variable_sens, suggested_variable_sens)::float8 AS variable_sens,
     coalesce(enacted_rate, suggested_rate)::float8 AS rate,
     coalesce(enacted_duration, suggested_duration)::float8 AS duration,
     coalesce(enacted_units, suggested_units)::float8 AS smb,
     coalesce(enacted_algorithm, suggested_algorithm) AS algorithm,
     coalesce(enacted_running_dynamic_isf, suggested_running_dynamic_isf) AS dynamic_isf,
     (enacted_reason IS NOT NULL OR enacted_bg IS NOT NULL) AS enacted,
     coalesce(enacted_reason, suggested_reason) AS reason,
     CASE WHEN date >= $3 AND date < $4 THEN coalesce(enacted_console_log, suggested_console_log) END AS console_log,
     CASE WHEN date >= $3 AND date < $4 THEN coalesce(enacted_console_error, suggested_console_error) END AS console_error
   FROM devicestatus
   WHERE date >= $1 AND date < $2 AND ${VALID}
     AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL OR suggested_reason IS NOT NULL)
   ORDER BY date`;

// AAPS sends its configuration with some statuses only, apart from the runs.
const CONFIGURATION = `SELECT date, configuration_aps AS aps, configuration_sensitivity AS sensitivity,
     configuration_insulin AS insulin, configuration_version AS version,
     aps_configuration AS aps_settings, sensitivity_configuration AS sensitivity_settings,
     insulin_configuration AS insulin_settings, safety_configuration AS safety_settings
   FROM devicestatus
   WHERE date <= $1 AND ${VALID} AND configuration_aps IS NOT NULL
   ORDER BY date DESC LIMIT 1`;

const HEART_RATE = `SELECT date, beats_per_minute::float8 AS bpm FROM heartrate
   WHERE date >= $1 AND date < $2 AND ${VALID} AND beats_per_minute > 0 ORDER BY date`;

// The profile of the newest switch with an embedded profile before the end,
// else the default profile of the newest stored profile.
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

/**
 * Everything about [from, to) (ms) that a review needs: { from, to, start,
 * end, timeZone, readings, treatments, runs, heartRate, profile,
 * configuration }; start and end include the time before and after.
 */
/**
 * The profile in effect at `t` (ms): the newest profile switch with an
 * embedded profile, else the default profile of the newest stored profile.
 * { date, name, dia, units, timezone, percentage?, timeshift?, schedules, source } or null.
 */
export async function profileAt (pool, t) {
  const [switched, stored] = await Promise.all([pool.query(SWITCH_PROFILE, [new Date(t)]), pool.query(STORE_PROFILE, [new Date(t)])]);
  const profile = switched.rows[0] || stored.rows[0] || null;
  return profile && { ...profile, date: ms(profile.date), source: switched.rows[0] ? 'profile switch' : 'stored profile' };
}

export async function loopContext (pool, { from, to, timeZone, now = Date.now() }) {
  const start = from - BEFORE;
  const end = Math.min(to + AFTER, now);
  const range = [new Date(start), new Date(end)];
  const [readings, treatments, runs, heartRate, configuration, profile] = await Promise.all([
    pool.query(READINGS, range),
    pool.query(TREATMENTS, range),
    pool.query(RUNS, [...range, new Date(from), new Date(to)]),
    pool.query(HEART_RATE, range),
    pool.query(CONFIGURATION, [new Date(to)]),
    profileAt(pool, to),
  ]);
  return {
    from,
    to,
    start,
    end,
    timeZone,
    readings: readings.rows.map((r) => ({ ...r, date: ms(r.date) })),
    treatments: treatments.rows.map((r) => ({ ...r, date: ms(r.date) })),
    runs: runs.rows.map((r) => ({ ...r, date: ms(r.date) })),
    heartRate: heartRate.rows.map((r) => ({ ...r, date: ms(r.date) })),
    profile,
    configuration: configuration.rows[0] ? { ...configuration.rows[0], date: ms(configuration.rows[0].date) } : null,
  };
}
