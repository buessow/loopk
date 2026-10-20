"""Trains glucose prediction models and compares them with baselines.

    uv run python train.py [--refresh] [--models ridge,mlp,gbm] [--oracle]

Splits by time: models are tuned on TRAIN and checked on VALIDATION, then
refit on both and evaluated once on TEST. Writes results/report.md.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from glupred import baselines
from glupred.features import HORIZONS, build_features
from glupred.grid import build_grid
from glupred.load import CACHE, load_all
from glupred.metrics import RANGES, by_range, low_warnings, summarize

TRAIN_FROM = '2019-05-07'   # first temp basal: delivered insulin is known from here
VALIDATION_FROM = '2025-01-01'
TEST_FROM = '2025-07-01'
RESULTS = Path(__file__).resolve().parent / 'results'


def grid_cached(refresh):
    path = CACHE / 'grid.parquet'
    if path.exists() and not refresh:
        return pd.read_parquet(path)
    grid = build_grid(load_all(refresh))
    grid.to_parquet(path)
    return grid


class PerHorizon:
    """One regressor per horizon column."""

    def __init__(self, factory):
        self.factory = factory

    def fit(self, X, Y, sample_weight=None):
        self.models = [self.factory().fit(X, Y[:, h], sample_weight=sample_weight) for h in range(Y.shape[1])]
        return self

    def predict(self, X):
        return np.column_stack([m.predict(X) for m in self.models])


MODELS = {
    'ridge': lambda: make_pipeline(StandardScaler(), Ridge(alpha=10.0)),
    'mlp': lambda: make_pipeline(StandardScaler(), MLPRegressor(
        hidden_layer_sizes=(128, 64), alpha=1e-3, batch_size=512, learning_rate_init=1e-3,
        max_iter=40, early_stopping=True, n_iter_no_change=5, random_state=1)),
    'gbm': lambda: PerHorizon(lambda: HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.1, max_leaf_nodes=63, early_stopping=True, random_state=1)),
}


def period(index, start, end=None):
    m = index >= pd.Timestamp(start, tz='UTC')
    if end:
        m &= index < pd.Timestamp(end, tz='UTC')
    return m


def low_weights(g_now, Y, reference=100.0):
    """Sample weights (reference / lowest glucose in the next hour)², clipped
    to [1/4, 4] and normalized to mean 1: samples heading low count up to
    16 times as much as those staying high."""
    lowest = np.min(Y + g_now[:, None], axis=1)
    w = np.clip((reference / lowest) ** 2, 0.25, 4.0)
    return w / w.mean()


def fit_predict(spec, X_train, Y_train, X_eval):
    """Fits model `spec` ('mlp', 'mlp:log', 'mlp:weighted', 'mlp:log+weighted')
    and returns (model, predicted glucose deltas for X_eval).

    `log` trains on log(g[i+h] / g[i]), so squared error approximates squared
    relative error; `weighted` uses low_weights()."""
    t = time.time()
    name, _, options = spec.partition(':')
    options = set(options.split('+')) - {''}
    g_train = X_train['g_now'].to_numpy()
    g_eval = X_eval['g_now'].to_numpy()
    Y = Y_train.to_numpy()
    target = np.log((Y + g_train[:, None]) / g_train[:, None]) if 'log' in options else Y
    scale = target.std(axis=0)
    model = MODELS[name]()
    step = model.steps[-1][0] if hasattr(model, 'steps') else None
    fit_args = {}
    if 'weighted' in options:
        w = low_weights(g_train, Y)
        fit_args = {f'{step}__sample_weight': w} if step else {'sample_weight': w}
    model.fit(X_train.to_numpy(), target / scale, **fit_args)
    pred = model.predict(X_eval.to_numpy()) * scale
    if 'log' in options:
        pred = g_eval[:, None] * (np.exp(pred) - 1)
    print(f'  {spec}: {time.time() - t:.0f}s', flush=True)
    return model, pred


def table(rows):
    return pd.DataFrame(rows).set_index('model').round(1).to_markdown()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='reload from the database')
    ap.add_argument('--models', default='ridge,mlp,gbm')
    ap.add_argument('--oracle', action='store_true', help='also train with future insulin/carbs (leak)')
    args = ap.parse_args()
    models = [m for m in args.models.split(',') if m]

    grid = grid_cached(args.refresh)
    X, Y, info = build_features(grid)
    valid = info['valid'].to_numpy() & period(X.index, TRAIN_FROM)
    print(f'samples: {valid.sum()} of {len(X)} slots')
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    print(f'train {tr.sum()}, validation {va.sum()}, test {te.sum()}')

    g_now = X['g_now'].to_numpy()
    actual = Y.to_numpy() + g_now[:, None]

    # --- validation: tune on TRAIN only
    print('validation (fit on train):')
    val_preds = {'persistence': baselines.persistence(X[va]), 'linear trend 15m': baselines.linear_trend(X[va])}
    for name in models:
        _, val_preds[name] = fit_predict(name, X[tr], Y[tr], X[va])
    val_rows = [summarize(n, actual[va], d + g_now[va, None]) for n, d in val_preds.items()]
    print(table(val_rows))

    # --- test: refit on TRAIN + VALIDATION
    print('test (fit on train + validation):')
    fit = tr | va
    test_preds = {'persistence': baselines.persistence(X[te]), 'linear trend 15m': baselines.linear_trend(X[te])}
    fitted = {}
    for name in models:
        fitted[name], test_preds[name] = fit_predict(name, X[fit], Y[fit], X[te])
    test_rows = [summarize(n, actual[te], d + g_now[te, None]) for n, d in test_preds.items()]
    saved = {'g_now': g_now[te], **{f'actual_h{h + 1}': actual[te][:, h] for h in range(HORIZONS)}}
    for name, d in test_preds.items():
        saved.update({f'{name}_h{h + 1}': d[:, h] + g_now[te] for h in range(HORIZONS)})
    pd.DataFrame(saved, index=X.index[te]).to_parquet(CACHE / 'test_predictions.parquet')

    oracle_rows = []
    if args.oracle:
        Xo, _, _ = build_features(grid, oracle=True)
        for name in [m for m in models if m in ('ridge', 'gbm')][:1] or ['ridge']:
            _, d = fit_predict(name, Xo[fit], Y[fit], Xo[te])
            oracle_rows.append(summarize(f'{name} + future inputs (leak)', actual[te], d + g_now[te, None]))
        test_rows += oracle_rows
    print(table(test_rows))

    # --- AAPS's own predictions, on the test slots where it made one
    curves = baselines.aaps_curves(load_all()['aaps_predictions'], X.index)
    aaps_rows = []
    have = ~np.isnan(curves['auto'][:, HORIZONS - 1])
    sub = have[te]
    print(f'AAPS comparison: {sub.sum()} of {te.sum()} test samples have an AAPS prediction')
    for curve in ('auto', 'IOB', 'UAM', 'ZT'):
        if curve not in curves:
            continue
        c = curves[curve][te]
        m = sub & ~np.isnan(c).any(axis=1)
        aaps_rows.append(summarize(f'AAPS {curve} (n={m.sum()})', actual[te][m], c[m]))
    for name, d in test_preds.items():
        aaps_rows.append(summarize(f'{name} (same slots)', actual[te][sub], d[sub] + g_now[te][sub, None]))
    print(table(aaps_rows))

    # --- per glucose range and low warnings, test period
    range_tables = {}
    warn_rows = []
    for m in (30, 60):
        rows = []
        for name, d in test_preds.items():
            if name == 'linear trend 15m':
                continue
            rows += by_range(name, actual[te], d + g_now[te, None], m)
        range_tables[m] = pd.DataFrame(rows).set_index(['range', 'model']).sort_index(
            level=0, sort_remaining=False, key=lambda s: s.map({r[2]: i for i, r in enumerate(RANGES)})).round(1)
        warn_rows += [{**low_warnings(name, actual[te], d + g_now[te, None], m), 'model': f'{name} {m}m'}
                      for name, d in test_preds.items()]
        c = curves['IOB'][te]
        ok = ~np.isnan(c).any(axis=1)
        warn_rows.append({**low_warnings('AAPS IOB', actual[te][ok], c[ok], m), 'model': f'AAPS IOB {m}m (its slots)'})
    for m, t in range_tables.items():
        print(f'by actual glucose, {m} min ahead:')
        print(t.to_markdown())
    print(table(warn_rows))

    # --- report
    RESULTS.mkdir(exist_ok=True)
    mae = {name: list(np.round(np.mean(np.abs(d + g_now[te, None] - actual[te]), axis=0), 2))
           for name, d in test_preds.items()}
    report = [
        '# Glucose prediction: results',
        '',
        f'Generated {pd.Timestamp.now(tz="UTC"):%Y-%m-%d %H:%M} UTC by `modelling/train.py`.',
        '',
        f'- Train {TRAIN_FROM} – {VALIDATION_FROM} ({tr.sum()} samples), validation – {TEST_FROM} ({va.sum()}), '
        f'test {TEST_FROM} – end ({te.sum()}).',
        '- Errors in mg/dL. MAE/RMSE at 15–60 min ahead; Clarke zone A and D+E; '
        'recall/precision of predicting < 70 mg/dL.',
        '',
        '## Validation (fit on train)', '', table(val_rows), '',
        '## Test (fit on train + validation)', '', table(test_rows), '',
        '## Against AAPS predictions (test slots where AAPS made one)', '', table(aaps_rows), '',
        '## Test MAE per horizon (5–60 min)', '',
        pd.DataFrame(mae, index=[f'{5 * (h + 1)}m' for h in range(HORIZONS)]).T.to_markdown(), '',
        '## Test by actual glucose, 30 min ahead', '', range_tables[30].to_markdown(), '',
        '## Test by actual glucose, 60 min ahead', '', range_tables[60].to_markdown(), '',
        '## Low warnings (actual < 70): warn when the prediction is below 70 / 80 / 90', '',
        table(warn_rows), '',
    ]
    (RESULTS / 'report.md').write_text('\n'.join(report))
    (RESULTS / 'metrics.json').write_text(json.dumps(
        {'validation': val_rows, 'test': test_rows, 'aaps': aaps_rows}, indent=2, default=float))
    print(f'wrote {RESULTS / "report.md"}')


if __name__ == '__main__':
    main()
