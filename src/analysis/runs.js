// How the MCP tools and the misses read loop runs: grouped by algorithm,
// without duplicates.

/**
 * The runs grouped into periods of the same algorithm and dynamic ISF state:
 * [{ from, to, algorithm, dynamicIsf }]; runs that report neither are left out.
 */
export function algorithmPeriods (runs) {
  const periods = [];
  for (const r of runs) {
    if (r.algorithm == null && r.dynamic_isf == null) continue;
    const last = periods[periods.length - 1];
    if (last && last.algorithm === r.algorithm && last.dynamicIsf === r.dynamic_isf) last.to = r.date;
    else periods.push({ from: r.date, to: r.date, algorithm: r.algorithm, dynamicIsf: r.dynamic_isf });
  }
  return periods;
}

/** Loop runs without the duplicates some uploaders send (same reason within a minute). */
export function uniqueRuns (runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r.date - last.date < 60000 && r.reason === last.reason) continue;
    out.push(r);
  }
  return out;
}
