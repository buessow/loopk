// Records a prediction for every glucose reading as it arrives (table
// glucose_predictions), so the chart can show what was predicted for each
// moment 15 and 30 minutes before. Readings of the last day without a
// prediction are caught up too: after a model upload, a restart or a
// backlog upload from the phone.

import { buildInputs, historyMinutes, newestReading, readingsBetween, run, treatmentMinutes, treatmentsBetween } from './index.js';

const MIN = 60000;
const HOUR = 60 * MIN;

export class PredictionRecorder {
  /**
   * @param ctx app context (data, bus)
   * @param models the ModelStore
   */
  constructor (ctx, models, { minutes = [15, 30], catchUpHours = 24, delayMs = 2000 } = {}) {
    this.ctx = ctx;
    this.models = models;
    this.minutes = minutes;
    this.catchUpHours = catchUpHours;
    this.delayMs = delayMs;
    this.timer = null;
    this.running = null;
    this.again = false;
    this.started = false;
    this.onData = ({ colName }) => { if (colName === 'entries') this.schedule(); };
  }

  /** Records on new entries, and once now to catch up. */
  start () {
    this.started = true;
    this.ctx.bus.on('data-received', this.onData);
    this.schedule();
  }

  async stop () {
    this.started = false;
    this.ctx.bus.off('data-received', this.onData);
    clearTimeout(this.timer);
    await this.running;
  }

  /** Records after `delayMs` without new entries (uploads come in bursts), once started. */
  schedule () {
    if (!this.started) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), this.delayMs);
    this.timer.unref?.();
  }

  /** Records until nothing is left; a call while running makes it go again. */
  run () {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.record();
        } catch (err) {
          console.error('Recording glucose predictions failed:', err);
        }
      } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Predicts for the readings of the last day that have no prediction yet. Returns the number recorded. */
  async record () {
    const row = await this.models.current();
    if (!row) return 0;
    const { model } = row;
    const { data } = this.ctx;
    const newest = await newestReading(data);
    if (newest == null) return 0;
    const dates = await data.predictions.unpredicted(newest - this.catchUpHours * HOUR);
    if (!dates.length) return 0;
    const span = historyMinutes(model) * MIN;
    const readings = await readingsBetween(data, dates[0] - span, dates[dates.length - 1]);
    const slotMs = model.slotMinutes * MIN;
    const treatments = treatmentMinutes(model)
      ? await treatmentsBetween(data, dates[0] - treatmentMinutes(model) * MIN, (Math.floor(dates[dates.length - 1] / slotMs) + 1) * slotMs)
      : {};

    const out = { madeAt: [], minutes: [], date: [], sgv: [], low: [], high: [] };
    let first = 0;
    let last = 0;
    for (const t of dates) {
      // The readings up to t that buildInputs may use.
      while (readings[first].date < t - span) first++;
      while (last < readings.length && readings[last].date <= t) last++;
      const built = buildInputs(readings.slice(first, last), { model, treatments });
      if (!built.inputs) continue;
      const p = run(built.inputs, model);
      for (const m of this.minutes) {
        const h = m / model.slotMinutes - 1;
        out.madeAt.push(new Date(t));
        out.minutes.push(m);
        out.date.push(new Date(t + m * MIN));
        out.sgv.push(p.mean[h]);
        out.low.push(p['q0.1'][h]);
        out.high.push(p['q0.9'][h]);
      }
    }
    if (!out.sgv.length) return 0;
    return data.predictions.save(out, row.id);
  }
}

/** Recorded predictions for from <= date < to (ms), oldest first. */
export async function recordedPredictions (data, from, to) {
  return (await data.predictions.between(from, to)).map((r) => {
    const madeAt = new Date(r.made_at).getTime();
    return {
      identifier: `${madeAt}-${r.minutes}`,
      madeAt,
      minutes: r.minutes,
      date: new Date(r.date).getTime(),
      sgv: Math.round(r.sgv),
      low: r.low == null ? null : Math.round(r.low),
      high: r.high == null ? null : Math.round(r.high),
    };
  });
}
