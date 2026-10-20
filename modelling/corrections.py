"""What does a correction bolus do, AAPS's reaction included? Matched comparison.

    uv run python corrections.py

Corrections: manual boluses of 0.5 U or more, without sport in the 6 h
before, sensor gaps from 1 h before to the end of the window, carbs or
another manual bolus around them (windows per analysis, ANALYSES). Each
is compared with moments without a manual bolus (same conditions) of the
same glucose, 15-minute trend (4 mg/dL bins), IOB before the bolus (0.5 U
bins) and time of day; cells need 3 such moments. Day corrections rarely
have 4 h without carbs on both sides, so the day uses shorter windows,
coarser cells and follows 2 h. The difference in glucose after it, per unit of the
correction, is what a unit does with AAPS reacting as it does (it gives
fewer SMBs and less temp basal after a manual bolus).

Shown for night (23–6) and day (6–23), with and without corrections that
went below 70 within 4 h (excluding them selects on the outcome and makes
the effect look smaller; unlogged rescue carbs after a low do the same in
the other direction). An exponential curve (peak, duration) times a size
per unit is fitted to the per-unit effect.

Writes results/corrections.md (not committed: derived from health data).
"""

import numpy as np
import pandas as pd

from glupred.actions import insulin_kernel
from glupred.baselines import aaps_decisions
from glupred.features import interpolate
from glupred.load import load
from glupred.sensitivity import acting, prefix
from glupred.synthetic import acted
from train import RESULTS, grid_cached

AFTER = 48    # slots followed at most (4 h)
SHOWN = {'30 min': 6, '1 h': 12, '1.5 h': 18, '2 h': 24, '3 h': 36, '4 h': 48}
NIGHT = lambda h: (h >= 23) | (h < 6)
DAY = lambda h: (h >= 6) & (h < 23)
STRICT = {'carbs before': 48, 'after': 48, 'others': 36, 'from': 2021, 'glucose bin': 10, 'hour block': 2}
SHORT = {'carbs before': 36, 'after': 24, 'others': 24, 'from': 2019, 'glucose bin': 20, 'hour block': 4}
ANALYSES = {'night 23–6': (NIGHT, STRICT), 'day 6–23': (DAY, SHORT), 'night 23–6, day windows': (NIGHT, SHORT)}
MIN_CELL = 3
BOOT = 500


def fit_curve(per_unit):
    """Exponential curve and size (mg/dL per U over the whole curve) closest
    to the per-unit effect (0.. slots followed)."""
    best = None
    for peak in range(20, 125, 5):
        for dia in range(120, 481, 30):
            if 2 * peak >= dia:
                continue
            c = acted(insulin_kernel(peak=peak, duration=dia), len(per_unit) - 1)
            size = -np.sum(c * per_unit) / np.sum(c * c)
            err = np.sqrt(np.mean((per_unit + size * c) ** 2))
            if best is None or err < best[0]:
                best = (err, peak, dia, size)
    return best


def main():
    grid = grid_cached(False)
    n = len(grid)
    g = interpolate(grid['glucose'].to_numpy(), 2)
    manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
    auto = grid['smb'].to_numpy() + grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
    ik = insulin_kernel()
    iob = np.convolve(manual + auto, 1 - np.cumsum(ik))[:n]
    p_auto = prefix(acting(auto, ik))
    isf = aaps_decisions(load('aaps_decisions'), grid.index, fill=12)['isf'].to_numpy()
    hour = grid['local_hour'].to_numpy()
    year = grid.index.year.to_numpy()
    pc, pm, ps = prefix(grid['carbs'].to_numpy()), prefix(manual), prefix(grid['sport'].to_numpy())
    pg, pl = prefix(np.isnan(g).astype(float)), prefix((g < 70).astype(float))

    rows, fits, aaps_rows, per_unit_curves = [], [], [], {}
    ka = np.r_[0.0, np.cumsum(ik)]
    for name, (in_period, w) in ANALYSES.items():
        after = w['after']
        t = np.arange(96, n - AFTER - 1)
        t = t[in_period(hour[t])]
        clean = ((pc[t + after + 1] - pc[t - w['carbs before']]) == 0) & ((ps[t + 1] - ps[t - 72]) == 0) \
            & ((pg[t + after + 1] - pg[t - 12]) == 0) & (year[t] >= w['from']) & ~np.isnan(isf[t])
        others = (pm[t + w['others'] + 1] - pm[t - w['others']]) - manual[t]
        t = t[clean & (others == 0)]
        d = pd.DataFrame({'units': manual[t], 'g0': g[t], 'trend': g[t] - g[t - 3], 'iob': iob[t - 1],
                          'isf': isf[t], 'low': (pl[t + after + 1] - pl[t + 1]) > 0})
        cell = np.stack([(d.g0 // w['glucose bin']).astype(int), (d.trend // 4).astype(int), (d.iob // 0.5).astype(int),
                         ((np.floor(hour[t]).astype(int) + 1) % 24) // w['hour block']], axis=1)
        path = np.stack([g[t + s] - g[t] for s in range(after + 1)], axis=1)
        auto_acted = np.stack([p_auto[t + s + 1] - p_auto[t + 1] for s in (12, 24, 48) if s <= after], axis=1)
        for lows in ('all', 'no low in the window'):
            sel = np.ones(len(t), dtype=bool) if lows == 'all' else ~d.low.to_numpy()
            bol = np.where(sel & (d.units.to_numpy() >= 0.5))[0]
            ctl = np.where(sel & (d.units.to_numpy() == 0))[0]
            by = [cell[ctl, j] for j in range(cell.shape[1])]
            mean, count = pd.DataFrame(path[ctl]).groupby(by).mean(), pd.DataFrame(path[ctl]).groupby(by).size()
            auto_mean = pd.DataFrame(auto_acted[ctl]).groupby(by).mean()
            key = [tuple(c) for c in cell[bol]]
            ok = np.array([k in count.index and count[k] >= MIN_CELL for k in key], dtype=bool)
            bol = bol[ok]
            matched = [k for k, o in zip(key, ok) if o]
            diff = path[bol] - mean.loc[matched].to_numpy()
            units = d.units.to_numpy()[bol]
            per_unit = diff.mean(axis=0) / units.mean()
            rng = np.random.default_rng(0)
            boot = []
            for _ in range(BOOT):
                i = rng.integers(0, len(bol), len(bol))
                boot.append(diff[i].mean(axis=0) / units[i].mean())
            lo, hi = np.percentile(boot, [5, 95], axis=0)
            label = f'{name}, {lows}'
            per_unit_curves[label] = per_unit
            row = {'corrections': label, 'n (matched of all)': f'{len(bol)} of {len(key)}',
                   'median U': np.median(units), 'median glucose': np.median(d.g0.to_numpy()[bol])}
            for shown, s in SHOWN.items():
                row[shown] = f'{per_unit[s]:.0f} ({lo[s]:.0f} to {hi[s]:.0f})' if s <= after else ''
            row['AAPS expects 2 h'] = round(-np.median(d.isf.to_numpy()[bol]) * ka[24], 0)
            rows.append(row)
            err, peak, dia, size = fit_curve(per_unit)
            fits.append({'corrections': label, 'followed (h)': after / 12, 'peak (min)': peak, 'duration (h)': dia / 60,
                         'mg/dL per U (whole curve)': round(size, 1), 'fit error': round(err, 1),
                         'median AAPS ISF': round(np.median(d.isf.to_numpy()[bol]))})
            extra = auto_acted[bol] - auto_mean.loc[matched].to_numpy()
            aaps_rows.append({'corrections': label, **{
                f'by {h}': round(extra[:, j].mean() / units.mean(), 2)
                for j, h in enumerate(h for h, s in (('1 h', 12), ('2 h', 24), ('4 h', 48)) if s <= after)}})
            print(row, fits[-1], aaps_rows[-1], flush=True)

    curve_table = pd.DataFrame({label: [round(c[s], 1) if s < len(c) else np.nan for s in range(0, AFTER + 1, 3)]
                                for label, c in per_unit_curves.items()},
                               index=[f'{5 * s} min' for s in range(0, AFTER + 1, 3)])
    report = '\n'.join([
        '# Correction boluses: effect per unit, AAPS\'s reaction included', '',
        'Matched comparison (see corrections.py). Glucose change after a correction minus after matched moments '
        'without one, per unit of the correction (mg/dL), with 90% bootstrap intervals. "AAPS expects": its ISF × '
        'the insulin acted by 2 h on its curve, without its reaction.', '',
        pd.DataFrame(rows).to_markdown(index=False), '',
        '## AAPS\'s own insulin after a correction', '',
        'Extra insulin AAPS delivered (SMBs, temp basals beyond profile) that has acted, compared with the matched '
        'moments (U per U of correction). Negative: AAPS held back.', '',
        pd.DataFrame(aaps_rows).to_markdown(index=False), '',
        '## Fitted curve for the per-unit effect', '', pd.DataFrame(fits).to_markdown(index=False), '',
        '## Per-unit effect every 15 minutes', '', curve_table.to_markdown(), '',
    ])
    (RESULTS / 'corrections.md').write_text(report)
    print(report)


if __name__ == '__main__':
    main()
