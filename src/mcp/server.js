// An MCP server (Model Context Protocol) at /mcp, for agents that look into
// the person's diabetes data: glucose, treatments, statistics such as time
// in range and GMI, the profile, the loop's misses, the AAPS loop's internal
// values per run, and a description of how AAPS doses. Read-only. Stateless
// Streamable HTTP: each request gets its own server. It takes the same access
// as the API (an access token as ?token=, a Bearer JWT or a session) and
// needs read access to entries, treatments and device status.

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GUIDE } from '../analysis/prompt.js';
import { validTimeZone } from '../reports/index.js';
import * as data from './data.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const READ = 'The MCP server needs read access to entries, treatments and device status: create a token with read access on the admin page and add it to the URL as ?token=.';
const GUIDE_URI = 'loopk://docs/aaps-algorithms';

const time = z.string().optional();
const units = z.enum(['mmol/L', 'mg/dL']).optional().describe('Glucose unit of the answer (default mmol/L).');
const timeZone = z.string().optional().describe('IANA time zone for the times in the answer (default the person\'s).');
const RANGE_NOTE = 'from and to are ISO 8601 times (e.g. 2026-10-24T06:00+02:00) or epoch milliseconds';

class ToolError extends Error {}

/** A time argument (ISO 8601 or epoch ms) as epoch ms. */
function parseTime (value, name) {
  if (value == null || value === '') return null;
  const t = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(t)) throw new ToolError(`${name} is not a time: use ISO 8601 such as 2026-10-24T06:00+02:00`);
  return t;
}

/** [from, to] (ms) of the arguments: to defaults to now, from to `back` before to; at most `max` long. */
function range (args, back, max) {
  const to = parseTime(args.to, 'to') ?? Date.now();
  const from = parseTime(args.from, 'from') ?? to - back;
  if (from >= to) throw new ToolError('from must be before to');
  if (to - from > max) throw new ToolError(`At most ${max >= DAY ? `${max / DAY} days` : `${max / HOUR} hours`} at once: split the period`);
  return [from, to];
}

export function createMcpServer (ctx) {
  const { pool } = ctx;
  const server = new McpServer(
    { name: 'loopk', version: '1.0.0' },
    {
      instructions: `loopk holds one person's type 1 diabetes data: CGM glucose, the treatments their AAPS (AndroidAPS) closed loop and they logged, and the loop's device status with its algorithm's decisions. Start with get_status for the present, get_statistics for a period, get_misses for times the loop dosed wrongly, and get_loop_runs for what the algorithm computed at each run. Read get_algorithm_guide before explaining loop decisions. Glucose comes in mmol/L unless you ask for mg/dL; times are local to the person (${RANGE_NOTE} in arguments). This is health data: it informs, it does not replace medical advice.`,
    },
  );

  // Common arguments: units and time zone, the latter defaulting to the profile's.
  const common = async (args) => {
    const tz = args.timeZone || await data.defaultTimeZone(ctx);
    if (!validTimeZone(tz)) throw new ToolError(`Unknown time zone ${tz}`);
    return { units: args.units || 'mmol/L', timeZone: tz };
  };
  const tool = (name, config, fn) => server.registerTool(name, { ...config, annotations: { readOnlyHint: true, openWorldHint: false, ...config.annotations } }, async (args) => {
    try {
      const result = await fn(args || {});
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
    } catch (err) {
      if (!(err instanceof ToolError)) console.error(`mcp ${name}:`, err);
      return { isError: true, content: [{ type: 'text', text: err instanceof ToolError ? err.message : 'The tool failed; see the server log.' }] };
    }
  });

  tool('get_status', {
    title: 'Current status',
    description: 'The present: latest glucose with trend and change, IOB, COB, the latest loop run (algorithm, eventual glucose, target, its reason), the running temp basal and temp target, the profile and percentage in effect, sport mode, heart rate, loopk\'s own glucose forecast if a model is set up, and the statistics of the last 24 hours (as get_statistics).',
    inputSchema: { units, timeZone },
  }, async (args) => data.status(ctx, await common(args)));

  tool('get_statistics', {
    title: 'Glucose and insulin statistics',
    description: `Statistics for a period (default the last 14 days, at most 366): readings and CGM coverage, mean glucose, SD, CV, GMI (glucose management indicator, %), time in the five standard ranges (very low, low, target, high, very high; percent of readings), insulin delivered (bolus incl. SMB, basal, the profile basal it replaced; totals and per day), carbs and mean heart rate. group_by "day" adds the same per local day, "hour_of_day" per hour of the day (0-23) over the period. ${RANGE_NOTE}.`,
    inputSchema: { from: time, to: time, group_by: z.enum(['none', 'day', 'hour_of_day']).optional(), units, timeZone },
  }, async (args) => {
    const [from, to] = range(args, 14 * DAY, 366 * DAY);
    return data.statistics(pool, { from, to, groupBy: args.group_by, ...await common(args) });
  });

  tool('get_glucose', {
    title: 'Glucose readings',
    description: `CGM readings (about one per 5 minutes) with their trend arrows, for a period (default the last 24 hours, at most 14 days), as rows [time, glucose, trend]. ${RANGE_NOTE}.`,
    inputSchema: { from: time, to: time, units, timeZone },
  }, async (args) => {
    const [from, to] = range(args, DAY, 14 * DAY);
    return data.glucoseReadings(pool, { from, to, ...await common(args) });
  });

  tool('get_treatments', {
    title: 'Treatments',
    description: `What was given and logged in a period (default the last 24 hours, at most 14 days): boluses (smb true for the loop's SMBs), carbs, temp basals (rate U/h, minutes), temp targets, profile switches (with percentage), notes and the like. ${RANGE_NOTE}.`,
    inputSchema: { from: time, to: time, units, timeZone },
  }, async (args) => {
    const [from, to] = range(args, DAY, 14 * DAY);
    return data.treatmentRecords(pool, { from, to, ...await common(args) });
  });

  tool('get_heart_rate', {
    title: 'Heart rate',
    description: `Heart-rate readings (bpm) in a period (default the last 24 hours, at most 14 days), as rows [time, bpm]. ${RANGE_NOTE}.`,
    inputSchema: { from: time, to: time, timeZone },
  }, async (args) => {
    const [from, to] = range(args, DAY, 14 * DAY);
    return data.heartRate(pool, { from, to, ...await common(args) });
  });

  tool('get_profile', {
    title: 'Profile in effect',
    description: 'The therapy profile in effect at a time (default now): basal rates (U/h), ISF (glucose per U), carb ratio (g per U), targets and DIA, as schedules of [local time of day, value], with the percentage and time shift of the profile switch.',
    inputSchema: { at: time.describe('ISO 8601 time or epoch ms (default now)'), units, timeZone },
  }, async (args) => data.profile(pool, { at: parseTime(args.at, 'at') ?? Date.now(), ...await common(args) }));

  tool('get_profile_usage', {
    title: 'Basal profiles in use',
    description: `Which basal profiles (name and schedule version) were in effect in a period (default the last 30 days, at most 366), how long, at which percentages, and the insulin delivered under each, with mean and SD per hour of day. ${RANGE_NOTE}.`,
    inputSchema: { from: time, to: time, timeZone },
  }, async (args) => {
    const [from, to] = range(args, 30 * DAY, 366 * DAY);
    return data.profiles(pool, { from, to, ...await common(args) });
  });

  tool('get_misses', {
    title: 'Where the loop got it wrong',
    description: `The loop's misses in a period (default the last 30 days, at most 366), newest first. "low": a low below 3.9 mmol/L (70 mg/dL) after SMBs in the hour before it, more than the low left room for (excessUnits); flags such as "SMBs after rescue carbs" or "after a low"; missedBy is how far the low went below the lowest glucose the loop allowed for (minGuardBG). "high": a high above 13.9 (250) lasting 30 minutes that the loop dosed for far too mildly (dosedFor: what it sized insulin for; missingUnits: what it would have asked for had it seen the peak) or that a limit held back (limits: the SMB size limit, max IOB, max safe basal, with the AAPS setting behind it, or max IOB 0 from duplicate glucose readings; causedByDuplicates when that alone held it back). Each has a summary sentence and what the loop expected at the deciding run. Estimates from the loop's ISF, for finding patterns. ${RANGE_NOTE}.`,
    inputSchema: { from: time, to: time, kind: z.enum(['all', 'low', 'high']).optional(), units, timeZone },
  }, async (args) => {
    const [from, to] = range(args, 30 * DAY, 366 * DAY);
    return data.misses(pool, { from, to, kind: args.kind || 'all', ...await common(args) });
  });

  tool('get_loop_runs', {
    title: 'Loop algorithm internals',
    description: `What the AAPS algorithm computed and decided at each run (about every 5 minutes) in a period (default the last 3 hours, at most 24; with console at most 3): algorithm and dynamic ISF, BG, eventual BG, target, ISF used, sensitivity ratio, IOB, basal IOB, COB, insulinReq, minPredBG, minGuardBG, where the IOB/COB/UAM predictions end, the temp basal and SMB it set, the limits it hit, and its reason text; plus the loop configuration (AAPS settings) and the algorithm periods. curves adds the predicted curves (one value per 5 minutes); console adds the algorithm's step-by-step log. Read get_algorithm_guide to interpret them. ${RANGE_NOTE}.`,
    inputSchema: {
      from: time,
      to: time,
      curves: z.boolean().optional().describe('Add the predicted curves IOB, ZT, COB, UAM per run.'),
      console: z.boolean().optional().describe('Add the algorithm\'s console log per run (at most 3 hours).'),
      units,
      timeZone,
    },
  }, async (args) => {
    const [from, to] = range(args, 3 * HOUR, args.console ? 3 * HOUR : DAY);
    return data.loopRuns(pool, { from, to, curves: !!args.curves, console: !!args.console, ...await common(args) });
  });

  tool('get_algorithm_guide', {
    title: 'How AAPS doses',
    description: 'A guide to how the AAPS (AndroidAPS) algorithms decide: oref1 SMB, Dynamic ISF and AutoISF, the predictions (IOB, ZT, COB, UAM), eventual BG, minPredBG and minGuardBG, insulinReq, SMB sizing and limits, autosens, temp targets and profile switches, and how to read the reason text. Markdown. Also available as the resource ' + GUIDE_URI + '.',
    inputSchema: {},
  }, async () => GUIDE);

  server.registerResource('aaps-algorithms', GUIDE_URI, {
    title: 'How AAPS doses',
    description: 'A guide to how the AAPS algorithms decide (Markdown).',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }));

  return server;
}

/** POST /mcp: the MCP endpoint (Streamable HTTP, stateless, JSON responses). */
export function createMcpRoutes (ctx) {
  const router = express.Router();
  const read = [
    ctx.auth.require('api:entries:read', READ),
    ctx.auth.require('api:treatments:read', READ),
    ctx.auth.require('api:devicestatus:read', READ),
  ];
  router.post('/', read, express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const server = createMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });
  // No server-initiated streams or sessions in stateless mode.
  router.all('/', (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
  return router;
}
