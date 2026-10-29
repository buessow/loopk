// Synthetic conformance cases for the ported AAPS algorithms: generates
// random loop-run inputs, which AAPS's own determine_basal runs (the test
// LoopkCasesTest in the AAPS checkout), and compares AAPS's results with the
// port's (src/oref/determinebasal.js).
//
//   node scripts/oref-cases.js generate --n 3000 --seed 1 --out cases.jsonl
//   (in the AAPS checkout)
//   LOOPK_CASES=cases.jsonl LOOPK_RESULTS=results.jsonl TZ=UTC \
//     ./gradlew :plugins:aps:testFullDebugUnitTest --tests app.aaps.plugins.aps.LoopkCasesTest
//   node scripts/oref-cases.js compare --cases cases.jsonl --results results.jsonl [--out report.json]
//
// AAPS runs in UTC (TZ=UTC), and the port takes the minute of the hour in
// UTC too: it decides whether a temp is cancelled before the top of the
// hour. The generator is test/orefsynthetic.js; test/orefsynthetic.test.js
// keeps AAPS's results for some of the cases. The AAPS test is
// scripts/aaps/LoopkCasesTest.kt: copy it to the AAPS checkout's
// plugins/aps/src/test/kotlin/app/aaps/plugins/aps/ and run it with Android
// Studio's JDK (JAVA_HOME=.../Android Studio.app/Contents/jbr/Contents/Home).

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { differences, fromKotlin, generateCases, parseKotlin, portDecision } from '../test/orefsynthetic.js';

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

function generate (args) {
  const cases = generateCases(Number(args.seed), Number(args.n));
  writeFileSync(args.out, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`${cases.length} cases written to ${args.out}`);
}

function compare (args) {
  const cases = new Map(readLines(args.cases).map((l) => { const c = JSON.parse(l); return [c.id, c]; }));
  const report = [];
  const byAlgorithm = {};
  const byField = {};
  for (const line of readLines(args.results)) {
    const { id, result } = parseKotlin(line);
    const c = cases.get(id);
    const stats = (byAlgorithm[c.algorithm] ??= { cases: 0, same: 0, sameAction: 0, aapsErrors: 0, portErrors: 0 });
    stats.cases++;
    if (result.error) {
      stats.aapsErrors++;
      report.push({ id, algorithm: c.algorithm, aapsError: result.error });
      continue;
    }
    let port;
    try {
      port = portDecision(c);
    } catch (e) {
      stats.portErrors++;
      report.push({ id, algorithm: c.algorithm, portError: String(e.stack) });
      continue;
    }
    const diffs = differences(fromKotlin(result), port);
    if (!diffs.length) stats.same++;
    if (!diffs.some((d) => ['units', 'rate', 'duration'].includes(d.field))) stats.sameAction++;
    for (const d of diffs) byField[d.field] = (byField[d.field] ?? 0) + 1;
    if (diffs.length) report.push({ id, algorithm: c.algorithm, diffs });
  }
  console.log('Per algorithm: cases, identical (every field, curve and reason), same action (SMB, rate, duration), errors in AAPS, errors in the port');
  console.table(byAlgorithm);
  console.log('Cases with a difference, per field:');
  console.table(byField);
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(report, null, 1));
    console.log(`details in ${args.out}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      n: { type: 'string', default: '3000' },
      seed: { type: 'string', default: '1' },
      out: { type: 'string' },
      cases: { type: 'string' },
      results: { type: 'string' },
    },
  });
  if (command === 'generate' && values.out) generate(values);
  else if (command === 'compare' && values.cases && values.results) compare(values);
  else {
    console.error('usage: oref-cases.js generate --n N --seed S --out cases.jsonl | compare --cases cases.jsonl --results results.jsonl [--out report.json]');
    process.exit(1);
  }
}
