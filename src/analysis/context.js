// The profile in effect at a time, for the MCP tools.

const ms = (d) => (d == null ? null : new Date(d).getTime());

/**
 * The profile in effect at `t` (ms): the newest profile switch with an
 * embedded profile, else the default profile of the newest stored profile.
 * { date, name, dia, units, timezone, percentage?, timeshift?, schedules, source } or null.
 */
export async function profileAt (data, t) {
  const [switched, stored] = await Promise.all([data.profiles.switchedAt(t), data.profiles.storedAt(t)]);
  const profile = switched || stored || null;
  return profile && { ...profile, date: ms(profile.date), source: switched ? 'profile switch' : 'stored profile' };
}
