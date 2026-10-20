// Prediction models in the database (table prediction_models). The newest
// upload is the one in use. An upload is refused unless its structure fits
// index.js and its bundled checks (synthetic readings and treatments with
// the outputs Python computed, see modelling/export.py) come out the same
// here.

import { buildInputs, run } from './index.js';

const TOLERANCE = 1e-3; // mg/dL, and probability × 1000
const SUPPORTED_INPUTS = /^(g_now|gd_\d+|hour_sin|hour_cos|g_mean_\d+d|(ia|ca)_(past|fut)_\d+|iob|cob|profile_basal)$/;
const TREATMENT_INPUTS = /^((ia|ca)_(past|fut)_\d+|iob|cob|profile_basal)$/;

const isNumbers = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v));
const isKernel = (a) => Array.isArray(a) && a.length > 0 && isNumbers(a, a.length);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Problems that keep `model` from running here, as a list of messages. */
export function modelProblems (model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return ['the model must be a JSON object'];
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  need(typeof model.version === 'string' && model.version.trim(), 'version must be a non-empty string');
  need(model.slotMinutes === 5, 'slotMinutes must be 5');
  need(Number.isInteger(model.history) && model.history > 1, 'history must be an integer above 1');
  need(Number.isInteger(model.interpolateSlots) && model.interpolateSlots >= 0, 'interpolateSlots must be a non-negative integer');
  need(Number.isInteger(model.horizons) && model.horizons >= 6, 'horizons must be an integer of at least 6 (30 minutes)');
  need(typeof model.fallbackTimeZone === 'string', 'fallbackTimeZone must be a time zone name');
  need(typeof model.lowWarning === 'number' && model.lowWarning > 0 && model.lowWarning < 1, 'lowWarning must be a probability');
  need(Array.isArray(model.quantiles) && model.quantiles.includes(0.1) && model.quantiles.includes(0.9), 'quantiles must include 0.1 and 0.9');
  need(Array.isArray(model.events) && model.events.includes('p_low_30'), 'events must include p_low_30');
  const inputs = Array.isArray(model.inputs) ? model.inputs : [];
  need(inputs.includes('g_now') && inputs.every((name) => SUPPORTED_INPUTS.test(name)
    && (!name.startsWith('gd_') || Number(name.slice(3)) < model.history)), 'inputs must be g_now, gd_<lag below history>, hour_sin, hour_cos, g_mean_<days>d, ia_/ca_past_/fut_<slots>, iob, cob or profile_basal');
  need(isNumbers(model.mean, inputs.length) && isNumbers(model.scale, inputs.length), 'mean and scale need one number per input');
  const levelDays = inputs.filter((name) => name.startsWith('g_mean_')).map((name) => Number(name.slice(7, -1)));
  if (levelDays.length) {
    need(levelDays.every((d) => d >= 1 && d <= 14), 'g_mean_<days>d inputs need 1 to 14 days');
    need(typeof model.levelFallback === 'number' && Number.isFinite(model.levelFallback), 'levelFallback must be a number');
  }
  if (inputs.some((name) => TREATMENT_INPUTS.test(name))) {
    need(isKernel(model.insulinKernel) && isKernel(model.carbKernel), 'insulinKernel and carbKernel must be lists of numbers');
    need(isCount(model.insulinStaleSlots) && model.insulinStaleSlots > 0, 'insulinStaleSlots must be a positive integer');
    const r = model.rescueCarbs || {};
    need(typeof r.low === 'number' && typeof r.grams === 'number' && isCount(r.aboveSlots) && isCount(r.quietSlots),
      'rescueCarbs needs low, grams, aboveSlots and quietSlots');
    const d = model.duplicates || {};
    need(['seconds', 'insulin', 'carbs'].every((k) => typeof d[k] === 'number' && d[k] >= 0),
      'duplicates needs seconds, insulin and carbs');
    need(inputs.every((name) => !/_(past|fut)_\d+$/.test(name) || Number(name.split('_')[2]) < model.history),
      'activity inputs must be within the history');
  }
  need(isNumbers(model.targetScale, model.horizons), 'targetScale needs one number per horizon');
  if (problems.length) return problems;

  if (!Array.isArray(model.layers) || !model.layers.length) return ['layers must be a non-empty list'];
  let width = inputs.length;
  model.layers.forEach((layer, k) => {
    const rows = layer?.weights;
    if (!Array.isArray(rows) || !rows.length || !rows.every((row) => isNumbers(row, width)) || !isNumbers(layer.bias, rows.length)) {
      problems.push(`layer ${k}: weights must be ${width} numbers per output, with one bias per output`);
      return;
    }
    width = rows.length;
  });
  const outputs = model.horizons * (1 + model.quantiles.length) + model.events.length;
  need(!problems.length && width === outputs, `the last layer must have ${outputs} outputs`);
  if (problems.length) return problems;

  if (!Array.isArray(model.checks) || !model.checks.length) return ['checks must list synthetic readings with their expected outputs'];
  model.checks.forEach((check, i) => {
    try {
      const built = buildInputs(check.readings, { model, treatments: check.treatments });
      const e = check.expected;
      if (!built.inputs) return problems.push(`check ${i}: no inputs (${built.reason})`);
      const out = run(built.inputs, model);
      const off = Math.max(
        ...['mean', 'q0.1', 'q0.9'].flatMap((key) => out[key].map((v, h) => Math.abs(v - e[key][h]))),
        Math.abs(out.p_low_30 - e.p_low_30) * 1000);
      if (!(off <= TOLERANCE)) problems.push(`check ${i} (${check.name}): outputs differ from Python by up to ${off}`);
    } catch (err) {
      problems.push(`check ${i}: ${err.message}`);
    }
  });
  return problems;
}

/** Newest model, cached until another one is uploaded (by any server). */
export class ModelStore {
  constructor (pool) {
    this.pool = pool;
    this.cached = null;
  }

  async current () {
    const { rows } = await this.pool.query('SELECT id FROM prediction_models ORDER BY id DESC LIMIT 1');
    if (!rows.length) return null;
    if (this.cached?.id !== rows[0].id) {
      const { rows: [row] } = await this.pool.query(
        'SELECT id, model, uploaded_by, created_at FROM prediction_models WHERE id = $1', [rows[0].id]);
      this.cached = row;
    }
    return this.cached;
  }

  async save (model, uploadedBy) {
    const { rows: [row] } = await this.pool.query(
      `INSERT INTO prediction_models (version, model, uploaded_by) VALUES ($1, $2, $3)
       RETURNING id, model, uploaded_by, created_at`, [model.version, JSON.stringify(model), uploadedBy]);
    this.cached = row;
    return row;
  }
}

/** What GET/PUT /api/prediction/model report about a stored model. */
export function modelInfo (row) {
  const { version, description, inputs, horizons, lowWarning, metrics } = row.model;
  return { id: String(row.id), version, description, inputs, horizons, lowWarning, metrics, uploadedBy: row.uploaded_by, uploadedAt: row.created_at };
}
