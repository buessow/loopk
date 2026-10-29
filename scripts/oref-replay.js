// The replay check (docs/simulator-plan.md, phase 2): rebuilds the inputs
// of the loop runs in a period from the database in DATABASE_URL, decides
// with the ported AAPS algorithm and reports how often it matches what AAPS
// did. Details per run go to --out (health data: keep it out of git).
//
//   node --env-file=.env scripts/oref-replay.js [--days 3] [--to 2026-10-24T12:00Z] [--out file.json]
//
// The sensitivity ratio is the one AAPS recorded for each run: loopk can't
// rebuild autosens exactly (docs/simulator-plan.md). --rebuild-ratio
// rebuilds it, to compare.
//
// --settings takes AAPS's preferences instead of the inferred settings:
// the phone's shared_prefs XML (adb exec-out run-as
// info.nightscout.androidaps cat
// shared_prefs/info.nightscout.androidaps_preferences.xml) or a JSON object
// of preference keys. It holds credentials: keep it out of the repository.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPool } from '../src/db/index.js';
import { replay } from '../src/oref/replay.js';
import { fromAapsPreferences } from '../src/oref/settings.js';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '3' },
    to: { type: 'string' },
    out: { type: 'string' },
    exclude: { type: 'string', default: '' },
    'rebuild-ratio': { type: 'boolean', default: false },
    settings: { type: 'string' },
  },
});

/** AAPS's preferences from shared_prefs XML or JSON: { key: value }. */
function readPreferences (file) {
  const text = readFileSync(file, 'utf8');
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const prefs = {};
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const m of text.matchAll(/<(\w+) name="([^"]*)"(?: value="([^"]*)")?\s*(?:\/>|>([^<]*)<\/\1>)/g)) {
    prefs[unescape(m[2])] = unescape(m[3] ?? m[4] ?? '');
  }
  return prefs;
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set: run with --env-file=.env');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL);
const to = args.to ? Date.parse(args.to) : Date.now();
const from = to - Number(args.days) * 24 * 3600000;
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '-');

try {
  const started = Date.now();
  const settings = args.settings ? fromAapsPreferences(readPreferences(args.settings)) : {};
  const result = await replay(pool, { from, to, excludeDevices: args.exclude ? args.exclude.split(',') : [], recordedRatio: !args['rebuild-ratio'], settings });
  console.log(`Runs from ${new Date(from).toISOString()} to ${new Date(to).toISOString()} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log('Settings not from AAPS defaults:');
  for (const [k, source] of Object.entries(result.settings.sources)) {
    if (source !== 'default') console.log(`  ${k} = ${JSON.stringify(result.settings.values[k])} (${source})`);
  }
  for (const [algorithm, g] of Object.entries(result.summary)) {
    const ok = g.runs - g.errors;
    console.log(`\n${algorithm}: ${g.runs} runs, ${g.errors} not rebuilt`);
    console.log(`  same action: ${pct(g.sameAction, ok)}, eventual BG within 5 mg/dL: ${pct(g.eventual, ok)}`);
    console.log(`  inputs the same: ${Object.entries(g.checks).map(([k, n]) => `${k} ${pct(n, ok)}`).join(', ')}`);
    console.log(`  first stage that differs: ${Object.entries(g.stages).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  }
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(result, null, 1));
    console.log(`\nDetails: ${args.out}`);
  }
} finally {
  await pool.end();
}
