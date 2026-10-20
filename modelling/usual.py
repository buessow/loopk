"""How predictable are the usual actions: eating, and the insulin delivered?

    uv run python usual.py

Step 1 of a forecast that states what it assumes ("lands at 95 in 1 h if you
eat about 15 g as usual and AAPS gives 0.8 U"). For the 30 / 60 / 120
minutes after each test slot, predicts:
- whether carbs are eaten (at least 5 g) and how many grams are expected,
- the insulin delivered beyond the profile basal (boluses, SMBs, temp basals),
  and separately what AAPS decides (SMBs and temp basals) and the boluses
  given by hand,
from the time of day and week only, from glucose and the time, and from
everything known (glucose, insulin and carbs so far, heart rate). Gradient
boosting; scored on the test period. Writes results/usual.md.
"""

import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import brier_score_loss, roc_auc_score

from glupred.features import INTERPOLATE_SLOTS, build_features, interpolate, rescue_carbs
from glupred.grid import FALLBACK_TZ
from glupred.usual import ATE_GRAMS, ahead, behind, usual_targets
from train import RESULTS, TEST_FROM, TRAIN_FROM, grid_cached, period

MINUTES = (30, 60, 120)
RECENT = (30, 60, 120, 240)


def inputs(grid, X):
    """Input sets: the time only, glucose and time, everything."""
    local = X.index.tz_convert(FALLBACK_TZ)
    day = (local.dayofweek + grid['local_hour'].to_numpy() / 24) / 7
    X = X.assign(week_sin=np.sin(2 * np.pi * day), week_cos=np.cos(2 * np.pi * day),
                 weekend=(local.dayofweek >= 5).astype(float))
    carbs = np.nan_to_num(grid['carbs'].to_numpy())
    net = grid['bolus'].to_numpy() + grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
    for m in RECENT:
        X[f'carbs_last_{m}'] = behind(carbs, m // 5)
        X[f'insulin_last_{m}'] = behind(net, m // 5)
    last = np.where(carbs > 0, np.arange(len(carbs)), -10 ** 9)
    X['since_carbs_h'] = np.minimum((np.arange(len(carbs)) - np.maximum.accumulate(last)) * 5 / 60, 24.0)
    cols = list(X.columns)
    time_only = ['hour_sin', 'hour_cos', 'week_sin', 'week_cos', 'weekend']
    return X, {
        'time of day and week': time_only,
        'glucose + time': [c for c in cols if c.startswith(('g_now', 'gd_'))] + time_only,
        'everything': cols,
    }


def fit(model, X, y, tr):
    return model.fit(X[tr], y[tr])


def insulin_row(m, label, inputs, q, actual, after_meal, falling):
    r2 = lambda k: 1 - np.mean((q[k] - actual[k]) ** 2) / np.var(actual[k])
    every = np.ones(len(actual), dtype=bool)
    return {'window': f'{m} min', 'insulin': label, 'inputs': inputs,
            'mean U': actual.mean(), 'SD U': actual.std(), 'MAE U': np.mean(np.abs(q - actual)),
            'R²': r2(every), 'after meal: R²': r2(after_meal), 'falling: R²': r2(falling)}


def situations(X):
    """Glucose situations at the prediction time, by level and 15-minute change."""
    g = X['g_now'].to_numpy()
    d = -X['gd_3'].to_numpy()  # change over the last 15 minutes
    normal = (g >= 80) & (g <= 180)
    return {
        'low (< 70)': g < 70,
        '70–80, falling': (g >= 70) & (g < 80) & (d < 0),
        '70–80, not falling': (g >= 70) & (g < 80) & (d >= 0),
        '80–180, falling 10+': normal & (d <= -10),
        '80–180, steady': normal & (np.abs(d) < 10),
        '80–180, rising 10+': normal & (d >= 10),
        '> 180, rising': (g > 180) & (d >= 5),
        '> 180, steady or falling': (g > 180) & (d < 5),
    }


def situation_rows(m, sits, te, ate, ate_assumed, preds):
    rows = []
    for label, k in sits.items():
        k = k[te]
        a = ate[te][k]
        row = {'window': f'{m} min', 'situation': label, 'share %': 100 * k.mean(),
               'eats %': 100 * a.mean(), 'eats incl. assumed %': 100 * ate_assumed[te][k].mean(),
               'predicted %': 100 * preds['everything'][k].mean()}
        for name, p in preds.items():
            row[f'AUC {name}'] = roc_auc_score(a, p[k]) if 0 < a.mean() < 1 else np.nan
        rows.append(row)
    return rows


def binned(pred, actual, edges):
    """Mean actual per bin of the prediction: 'range: predicted → actual (share)'."""
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        k = (pred >= lo) & (pred < hi)
        if k.sum() >= 50:
            out.append(f'{lo:g}–{hi:g}: {pred[k].mean():.2f} → {actual[k].mean():.2f} ({100 * k.mean():.0f}%)')
    return '; '.join(out)


def main():
    t0 = time.time()
    grid = grid_cached(False)
    X, _, info = build_features(grid, rescue=None, horizons=1)
    X, sets = inputs(grid, X)
    T = usual_targets(grid, MINUTES)
    valid = info['valid'].to_numpy() & T.notna().all(axis=1).to_numpy()
    tr = valid & period(X.index, TRAIN_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    g = X['g_now'].to_numpy()
    falling = (g < 110) & (X['gd_3'].to_numpy() >= 10)   # fell 10+ mg/dL in 15 min, under 110 now
    after_meal = X['carbs_last_30'].to_numpy() >= 5
    print(f'{tr.sum()} training and {te.sum()} test slots ({time.time() - t0:.0f} s)')

    eat_rows, insulin_rows, notes, sit_rows = [], [], [], []
    sits = situations(X)
    # Rescue carbs the glucose model may assume (features.rescue_carbs): 15 g
    # when glucose drops below 70 with nothing logged.
    logged = np.nan_to_num(grid['carbs'].to_numpy())
    assumed = rescue_carbs(interpolate(grid['glucose'].to_numpy(), INTERPOLATE_SLOTS), logged)
    for m in MINUTES:
        ate = T[f'ate_{m}'].to_numpy()
        carbs = T[f'carbs_{m}'].to_numpy()
        base_rate = ate[tr].mean()
        preds = {}
        for name, cols in sets.items():
            A = X[cols].to_numpy()
            clf = fit(HistGradientBoostingClassifier(max_iter=300, random_state=1), A, ate, tr)
            p = clf.predict_proba(A[te])[:, 1]
            preds[name] = p
            reg = fit(HistGradientBoostingRegressor(max_iter=300, random_state=1), A, carbs, tr)
            c = np.maximum(reg.predict(A[te]), 0)
            a, ac = ate[te], carbs[te]
            sf = falling[te]
            eat_rows.append({
                'window': f'{m} min', 'inputs': name,
                'eats %': 100 * a.mean(),
                'AUC': roc_auc_score(a, p),
                'Brier skill %': 100 * (1 - brier_score_loss(a, p) / brier_score_loss(a, np.full(len(a), base_rate))),
                'carbs MAE g': np.mean(np.abs(c - ac)),
                'carbs R²': 1 - np.mean((c - ac) ** 2) / np.var(ac),
                'falling: eats %': 100 * a[sf].mean(),
                'falling: predicted %': 100 * p[sf].mean(),
                'falling: AUC': roc_auc_score(a[sf], p[sf]) if 0 < a[sf].mean() < 1 else np.nan,
            })
            if name == 'everything':
                notes.append(f'- {m} min, P(eat) predicted → actual: {binned(p, a, [0, 0.05, 0.15, 0.3, 0.5, 0.7, 1.01])}')
                notes.append(f'- {m} min, expected carbs g predicted → actual: {binned(c, ac, [0, 2, 5, 10, 20, 40, 1000])}')

            sm = after_meal[te]
            for kind, label in (('insulin', 'all'), ('auto', 'AAPS (SMB + temp)'), ('manual', 'by hand')):
                y = T[f'{kind}_{m}'].to_numpy()
                q = fit(HistGradientBoostingRegressor(max_iter=300, random_state=1), A, y, tr).predict(A[te])
                insulin_rows.append(insulin_row(m, label, name, q, y[te], sm, sf))
            print(f'  {m} min, {name}: AUC {eat_rows[-1]["AUC"]:.3f}, insulin R² {insulin_rows[-3]["R²"]:.3f} ({time.time() - t0:.0f} s)')
        ate_assumed = ahead(logged + assumed, m // 5) >= ATE_GRAMS
        sit_rows += situation_rows(m, sits, te, ate, ate_assumed, preds)

    eat = pd.DataFrame(eat_rows).round(3)
    sit = pd.DataFrame(sit_rows).round(2)
    ins = pd.DataFrame(insulin_rows).sort_values(
        ['window', 'insulin'], kind='stable', key=lambda c: c.str.extract(r'^(\d+)', expand=False).astype(float) if c.name == 'window' else c).round(3)
    report = '\n'.join([
        '# Usual actions: how predictable', '',
        f'Test period from {TEST_FROM}; {te.sum()} slots. "Falling": under 110 mg/dL after falling 10+ in 15 min '
        f'({100 * falling[te].mean():.1f}% of slots). "After meal": 5+ g carbs in the last 30 min.', '',
        '## Eating', '', eat.to_markdown(index=False), '',
        'Calibration (everything):', '', *notes, '',
        '### By glucose situation', '',
        'Eating (logged carbs, 5+ g) by the situation at the prediction time. "incl. assumed": with the '
        '15 g of rescue carbs assumed when glucose drops below 70 with nothing logged. "predicted %": mean '
        'P(eat) with everything as inputs. AUC: how well each input set tells eating from not eating '
        'within the situation (0.5 = no better than chance).', '',
        sit.to_markdown(index=False), '',
        '## Insulin beyond the profile basal', '', ins.to_markdown(index=False), '',
    ])
    (RESULTS / 'usual.md').write_text(report)
    print(report)
    print(f'{time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
