"""Which MLP shape forecasts best? Compared on the test period.

    uv run python architectures.py

Two settings:
- server: glucose of the last 2 h and the time of day, 30 min ahead (the
  inputs and horizon of the model the server runs, export.py),
- all inputs: also insulin, carbs and heart rate, 2 h ahead.

Each shape is trained twice (seeds 1 and 2) on TRAIN, stopped early on
VALIDATION, and scored on TEST by MAE, RMSE and bias; the spread between
seeds shows how much of a difference is noise. Targets as in glupred/nn.py
(log change, only where nothing more is eaten).

Writes results/architectures.md (not committed: derived from health data).
"""

import time

import numpy as np
import pandas as pd

from export import INPUTS as SERVER_INPUTS
from glupred.features import build_features
from glupred.nn import Model
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

SETTINGS = {'server (glucose + time, 30 min)': (SERVER_INPUTS, 6, (15, 30)),
            'all inputs, 2 h': (None, 24, (30, 60, 120))}
SHAPES = {
    '128-64 (current)': {'hidden': (128, 64)},
    '256-128': {'hidden': (256, 128)},
    '128-64-32': {'hidden': (128, 64, 32)},
    '256-128-64': {'hidden': (256, 128, 64)},
    '512-256-128': {'hidden': (512, 256, 128)},
    '256-256-256-256': {'hidden': (256, 256, 256, 256)},
    '128-64, patience 8, lr 3e-4': {'hidden': (128, 64), 'patience': 8, 'lr': 3e-4},
    '256-128-64, patience 8, lr 3e-4': {'hidden': (256, 128, 64), 'patience': 8, 'lr': 3e-4},
}
SEEDS = (1, 2)


def main():
    grid = grid_cached(False)
    rows = []
    for setting, (inputs, horizons, minutes) in SETTINGS.items():
        X, Y, info = build_features(grid, rescue={}, horizons=horizons)
        if inputs:
            X = X[inputs]
        valid = info['valid'].to_numpy() & period(X.index, TRAIN_FROM)
        tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
        va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
        te = valid & period(X.index, TEST_FROM)
        Xn, Yn = X.to_numpy(), Y.to_numpy()
        g = X['g_now'].to_numpy()
        mask = info[[f'no_carbs_h{h + 1}' for h in range(horizons)]].to_numpy()
        actual = Yn[te] + g[te, None]
        print(f'{setting}: {X.shape[1]} inputs; train {tr.sum()}, validation {va.sum()}, test {te.sum()}', flush=True)
        for shape, opts in SHAPES.items():
            fit_opts = {k: v for k, v in opts.items() if k != 'hidden'}
            for seed in SEEDS:
                t = time.time()
                epochs = []
                m = Model(quantiles=(), events=(), hidden=opts['hidden'], seed=seed).fit(
                    Xn[tr], g[tr], Yn[tr], mask[tr], None, Xn[va], g[va], Yn[va], mask[va], None,
                    log=epochs.append, **fit_opts)
                p = m.predict(Xn[te], g[te])['mean']
                row = {'setting': setting, 'model': shape, 'seed': seed, 'epochs': len(epochs),
                       'seconds': round(time.time() - t)}
                for mi in minutes:
                    h = mi // 5 - 1
                    ok = mask[te, h]
                    err = p[ok, h] - actual[ok, h]
                    row[f'MAE {mi}m'] = np.mean(np.abs(err))
                    row[f'RMSE {mi}m'] = np.sqrt(np.mean(err ** 2))
                    row[f'bias {mi}m'] = np.mean(err)
                rows.append(row)
                print({k: (round(v, 2) if isinstance(v, float) else v) for k, v in row.items()}, flush=True)
    d = pd.DataFrame(rows)
    parts = ['# MLP shapes compared', '',
             f'Train {TRAIN_FROM} – {VALIDATION_FROM}, early stopping on – {TEST_FROM}, test from {TEST_FROM}. '
             f'Seeds {", ".join(map(str, SEEDS))}; mean of the seeds, and their range for MAE.', '']
    for setting in SETTINGS:
        s = d[d.setting == setting].drop(columns='setting').dropna(axis=1, how='all')
        metrics = [c for c in s.columns if c.split()[0] in ('MAE', 'RMSE', 'bias')]
        mean = s.groupby('model', sort=False)[metrics + ['epochs', 'seconds']].mean()
        for c in [c for c in metrics if c.startswith('MAE')]:
            spread = s.groupby('model', sort=False)[c].agg(lambda v: v.max() - v.min())
            mean[f'{c} seed range'] = spread
        parts += [f'## {setting}', '', mean.round(2).to_markdown(), '']
    (RESULTS / 'architectures.md').write_text('\n'.join(parts))
    print('\n'.join(parts))


if __name__ == '__main__':
    main()
