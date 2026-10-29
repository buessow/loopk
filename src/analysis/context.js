// The profile in effect at a time, for the MCP tools.

const VALID = 'is_valid IS DISTINCT FROM false';
const ms = (d) => (d == null ? null : new Date(d).getTime());

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
 * The profile in effect at `t` (ms): the newest profile switch with an
 * embedded profile, else the default profile of the newest stored profile.
 * { date, name, dia, units, timezone, percentage?, timeshift?, schedules, source } or null.
 */
export async function profileAt (pool, t) {
  const [switched, stored] = await Promise.all([pool.query(SWITCH_PROFILE, [new Date(t)]), pool.query(STORE_PROFILE, [new Date(t)])]);
  const profile = switched.rows[0] || stored.rows[0] || null;
  return profile && { ...profile, date: ms(profile.date), source: switched.rows[0] ? 'profile switch' : 'stored profile' };
}
