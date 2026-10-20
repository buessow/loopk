"""Is the forecast's bias a property of the test period? Other test sets,
and what reduces the bias.

    uv run python periods.py

- Rolling: each half-year from 2022 is the test set once; the model is
  trained on everything from TRAIN_FROM up to 6 months before it and
  stopped early (and calibrated) on those 6 months.
- Random weeks: every 5th week (by a fixed random draw) across all years is
  the test set, the others train (one in 9 of them for early stopping).
  Neighbouring weeks are similar, so this measures the error without
  changes over time.

Variants (VARIANTS): without the log calibration of glupred/nn.py, with
it, and with it plus the mean glucose of the last 1, 3 and 7 days as
inputs (features.py, level=True).

Both settings of architectures.py (the server model; all inputs, 2 h).
Bias > 0: forecast too high. Also the mean glucose and the mean actual
change over the horizon, to see whether the bias follows them.

Writes results/periods.md (not committed: derived from health data).
"""

import numpy as np
import pandas as pd

from export import INPUTS as SERVER_INPUTS
from glupred.features import LEVEL_DAYS, build_features
from glupred.nn import Model
from train import RESULTS, TRAIN_FROM, grid_cached

LEVEL = [f'g_mean_{d}d' for d in LEVEL_DAYS]
SETTINGS = {'server (glucose + time)': (SERVER_INPUTS, 6, (30,)),
            'all inputs, 2 h': (None, 24, (30, 60, 120))}
VARIANTS = {'uncalibrated': (False, False), 'calibrated': (True, False), 'calibrated + glucose level': (True, True)}
FIRST_TEST = '2022-01-01'
TEST_WEEK_SHARE = 0.2


def half_years(index):
    start = pd.Timestamp(FIRST_TEST, tz='UTC')
    while start < index[-1]:
        end = start + pd.DateOffset(months=6)
        yield start, end
        start = end


def score(model, X, g, Y, mask, sel, minutes):
    p = model.predict(X[sel], g[sel])['mean']
    actual = Y[sel] + g[sel, None]
    row = {'n': int(sel.sum()), 'mean glucose': np.mean(g[sel])}
    for m in minutes:
        h = m // 5 - 1
        ok = mask[sel, h]
        err = p[ok, h] - actual[ok, h]
        row[f'MAE {m}m'] = np.mean(np.abs(err))
        row[f'bias {m}m'] = np.mean(err)
    return row


def main():
    grid = grid_cached(False)
    sections = []
    for setting, (inputs, horizons, minutes) in SETTINGS.items():
        X, Y, info = build_features(grid, rescue={}, horizons=horizons, level=True)
        idx = X.index
        valid = info['valid'].to_numpy() & (idx >= pd.Timestamp(TRAIN_FROM, tz='UTC'))
        Yn, g = Y.to_numpy(), X['g_now'].to_numpy()
        mask = info[[f'no_carbs_h{h + 1}' for h in range(horizons)]].to_numpy()
        base_cols = inputs or [c for c in X.columns if c not in LEVEL]
        week = ((idx - idx[0]).days // 7).to_numpy()
        draw = np.random.default_rng(0).random(week.max() + 1)
        test_week = draw[week] < TEST_WEEK_SHARE
        val_week = (draw[week] >= TEST_WEEK_SHARE) & (draw[week] < TEST_WEEK_SHARE + (1 - TEST_WEEK_SHARE) / 9)

        rows, random_rows = [], []
        for variant, (calibrate, level) in VARIANTS.items():
            Xn = X[base_cols + (LEVEL if level else [])].to_numpy()

            def fit(tr, va):
                return Model(quantiles=(), events=(), calibrate=calibrate).fit(
                    Xn[tr], g[tr], Yn[tr], mask[tr], None, Xn[va], g[va], Yn[va], mask[va], None, log=lambda *_: None)

            for start, end in half_years(idx):
                stop = start - pd.DateOffset(months=6)
                tr = valid & (idx < stop)
                va = valid & (idx >= stop) & (idx < start)
                te = valid & (idx >= start) & (idx < end)
                if te.any():
                    rows.append({'test': f'{start:%Y-%m}', 'variant': variant,
                                 **score(fit(tr, va), Xn, g, Yn, mask, te, minutes)})
                    print(setting, rows[-1], flush=True)
            model = fit(valid & ~test_week & ~val_week, valid & val_week)
            for year in sorted(set(idx.year[valid & test_week])):
                sel = valid & test_week & (idx.year == year)
                random_rows.append({'test weeks in': str(year), 'variant': variant,
                                    **score(model, Xn, g, Yn, mask, sel, minutes)})
            random_rows.append({'test weeks in': 'all', 'variant': variant,
                                **score(model, Xn, g, Yn, mask, valid & test_week, minutes)})

        def wide(rows, key):
            d = pd.DataFrame(rows)
            metrics = [c for c in d.columns if c.startswith(('MAE', 'bias'))]
            out = d.pivot(index=key, columns='variant', values=metrics)[[(m, v) for m in metrics for v in VARIANTS]]
            out.columns = [f'{m} {v}' for m, v in out.columns]
            out.insert(0, 'mean glucose', d.groupby(key)['mean glucose'].first())
            return out.round(1)

        mean_rows = pd.DataFrame(rows).groupby('variant', sort=False)[
            [c for c in rows[0] if c.startswith(('MAE', 'bias'))]].mean()
        mean_abs_bias = pd.DataFrame(rows).groupby('variant', sort=False)[
            [c for c in rows[0] if c.startswith('bias')]].agg(lambda v: np.mean(np.abs(v)))
        mean_abs_bias.columns = [f'mean |{c}|' for c in mean_abs_bias.columns]
        summary = pd.concat([mean_rows, mean_abs_bias], axis=1).round(2)
        sections += [f'## {setting}', '', '### Rolling half-years: means over the half-years', '', summary.to_markdown(), '',
                     '### Rolling half-years', '', wide(rows, 'test').to_markdown(), '',
                     '### Random weeks (one model per variant for all years)', '',
                     wide(random_rows, 'test weeks in').to_markdown(), '']
        print('\n'.join(sections[-11:]), flush=True)
    report = '\n'.join(['# Forecast bias on other test sets', '',
                        'MLP 128-64 as in glupred/nn.py. Bias > 0: forecast too high; MAE and bias in mg/dL, '
                        'only where nothing more is eaten before the horizon.', ''] + sections)
    (RESULTS / 'periods.md').write_text(report)


if __name__ == '__main__':
    main()
