"""Can synthetic insulin break the "more insulin, higher glucose" pattern?

    uv run python synthetic.py

In the closed loop, big insulin goes with rising glucose (meals, unlogged
food, AAPS and you reacting), so the MLP (all inputs, 2 h ahead, "if
nothing more is eaten") reads insulin as a sign of rising glucose: an extra
dose barely lowers its forecast, a big one raises it. Synthetic copies of
real samples (glupred/synthetic.py: insulin inputs as if logged, glucose
in the history and the targets shifted by the effect) where that pattern
does not hold:

- random: -1 to +5 U at a random time in the last 2 h, any sample;
- peak or falling: +2 to +5 U in the last 30 min where glucose stopped
  rising after a rise of 15 mg/dL or more in the hour before, or falls by
  5 mg/dL or more per 15 min from above 120;
- meal bolus removed: up to 2 h after a manual bolus of 2 U or more with
  20 g or more carbs within 15 minutes of it, the bolus taken away (glucose
  rises by what it would have lowered).

The effect is the measured one, not AAPS's ISF: night corrections
(corrections.py) lowered glucose by EFFECT_PER_UNIT per unit along a curve
peaking at 35 min and done by 2 h, AAPS's reaction included. Removing a
meal bolus with that effect assumes AAPS would make up for it as it takes
back a correction; it would likely give more SMBs, so the real rise may be
smaller.

Models: real data only, and with each kind of synthetic copy (and the
targeted ones together, with and without the random ones). Compared on real accuracy (validation and test)
and on how the forecast responds to a dose (the effect assumed: same curve).

Writes results/synthetic.md (not committed: derived from health data).
"""

import numpy as np
import pandas as pd

from glupred.actions import insulin_kernel
from glupred.features import build_features
from glupred.nn import Model
from glupred.sensitivity import prefix
from glupred.synthetic import EFFECT_CURVE, EFFECT_PER_UNIT, add_insulin, copies, effect_curve, moments
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

HORIZONS = 24
MINUTES = (30, 60, 120)
GENERATORS = {
    'random': ('random',),
    'peak or falling': ('peak',),
    'meal bolus removed': ('meal',),
    'peak or falling + meal bolus removed': ('peak', 'meal'),
    'random + peak or falling + meal bolus removed': ('random', 'peak', 'meal'),
}
PROBE_SAMPLES = 20000


def main():
    grid = grid_cached(False)
    X, Y, info = build_features(grid, rescue={}, horizons=HORIZONS)
    valid = info['valid'].to_numpy() & period(X.index, TRAIN_FROM)
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    g_now = X['g_now'].to_numpy()
    Yn, Xn = Y.to_numpy(), X.to_numpy()
    actual = Yn + g_now[:, None]
    mask = info[[f'no_carbs_h{h + 1}' for h in range(HORIZONS)]].to_numpy()
    ik = insulin_kernel()
    effect = effect_curve(HORIZONS)

    n = len(grid)
    i = np.arange(n)
    manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
    p_manual, p_carbs = prefix(manual), prefix(grid['carbs'].to_numpy())
    win = lambda p, a, b: p[np.clip(i + b, 0, n)] - p[np.clip(i + a, 0, n)]
    m = moments(grid, X)
    peak, trend, after_meal, meal_ago = m['peak'], m['trend'], m['after_meal'], m['meal_ago']

    def synthetic(kind, sel, seed):
        xs, ys, j = copies(kind, X, Yn, sel, m, seed, HORIZONS)
        return xs, xs[:, 0], ys, mask[j]

    counts = {'random': int(tr.sum()), 'peak or falling': int(np.sum(tr & peak)),
              'meal bolus removed': int(np.sum(tr & after_meal))}
    print(f'train {tr.sum()}, validation {va.sum()}, test {te.sum()}; synthetic train copies {counts}', flush=True)

    def fit(kinds):
        parts_tr = [(Xn[tr], g_now[tr], Yn[tr], mask[tr])] + [synthetic(k, tr, 1 + s) for s, k in enumerate(kinds)]
        parts_va = [(Xn[va], g_now[va], Yn[va], mask[va])] + [synthetic(k, va, 11 + s) for s, k in enumerate(kinds)]
        stack = lambda parts: [np.concatenate(p) for p in zip(*parts)]
        return Model(quantiles=(), events=()).fit(*stack(parts_tr), None, *stack(parts_va), None, log=lambda *_: None)

    models = {'real data only': fit(())}
    for name, kinds in GENERATORS.items():
        print(f'training {name}', flush=True)
        models[name] = fit(kinds)

    situations = {
        'all': np.ones(n, dtype=bool),
        'correction 0–120 min ago (no carbs 4 h)': (win(p_manual, -23, 1) >= 0.5) & (win(p_carbs, -47, 1) == 0),
        'meal bolus 0–120 min ago': after_meal,
        'peak or falling': peak,
    }

    def accuracy(sel, label):
        idx = np.where(sel)[0]
        pred = {name: m.predict(Xn[idx], g_now[idx])['mean'] for name, m in models.items()}
        rows = []
        for sit, s in situations.items():
            k = s[idx]
            for name, p in pred.items():
                row = {'period': label, 'situation': sit, 'n': int(k.sum()), 'model': name}
                for minutes in MINUTES:
                    h = minutes // 5 - 1
                    ok = k & mask[idx, h]
                    row[f'MAE {minutes}m'] = np.mean(np.abs(p[ok, h] - actual[idx][ok, h]))
                for minutes in (60, 120):
                    h = minutes // 5 - 1
                    ok = k & mask[idx, h]
                    row[f'bias {minutes}m'] = np.mean(p[ok, h] - actual[idx][ok, h])
                rows.append(row)
        return pd.DataFrame(rows)

    acc = pd.concat([accuracy(va, 'validation'), accuracy(te, 'test')])
    print(acc.round(1).to_markdown(index=False), flush=True)

    # --- forecast response
    rng = np.random.default_rng(0)

    def probe_rows(label, sel, units_fn, ago_fn):
        j = np.where(sel)[0]
        j = j[rng.choice(len(j), min(PROBE_SAMPLES, len(j)), replace=False)]
        units, ago = units_fn(j), ago_fn(j)
        xd, yd = add_insulin(X.iloc[j], Yn[j], units, ago, EFFECT_PER_UNIT * units, ik, effect)
        changes = {'assumed effect': (xd[:, 0][:, None] + yd) - actual[j]}
        for name, m in models.items():
            changes[name] = m.predict(xd, xd[:, 0])['mean'] - m.predict(Xn[j], g_now[j])['mean']
        out = []
        for name, d in changes.items():
            row = {'change': label, 'n': len(j), 'forecast change': name}
            for minutes in MINUTES:
                row[f'{minutes}m'] = np.mean(d[:, minutes // 5 - 1])
            row['wrong direction at 60m %'] = 100 * np.mean(d[:, 11] * np.sign(units) > 0)
            out.append(row)
        return out

    now = lambda j: np.zeros(len(j), dtype=int)
    probes = []
    for u in (1, 2, 5, 10):
        probes += probe_rows(f'+{u} U now, any test sample', te, lambda j, u=u: np.full(len(j), float(u)), now)
    for u in (2, 5):
        probes += probe_rows(f'+{u} U now, at the peak or falling', te & peak, lambda j, u=u: np.full(len(j), float(u)), now)
        probes += probe_rows(f'+{u} U now, rising 5+ per 15 min', te & (trend >= 5),
                             lambda j, u=u: np.full(len(j), float(u)), now)
    probes += probe_rows('+2 U 1 h ago, any test sample', te, lambda j: np.full(len(j), 2.0),
                         lambda j: np.full(len(j), 12))
    probes += probe_rows('meal bolus removed, after a test meal', te & after_meal,
                         lambda j: -m['meal_units'][j], lambda j: meal_ago[j])
    probe = pd.DataFrame(probes)
    print(probe.round(1).to_markdown(index=False), flush=True)

    md = lambda d: d.round(1).to_markdown(index=False)
    report = '\n'.join([
        '# Synthetic insulin: random and targeted', '',
        f'Generated {pd.Timestamp.now(tz="UTC"):%Y-%m-%d %H:%M} UTC by `modelling/synthetic.py`. MLP 128-64 with all '
        f'inputs, 2 h ahead, calibrated (glupred/nn.py). Train {TRAIN_FROM} – {VALIDATION_FROM} ({tr.sum()} real samples; '
        f'synthetic copies: {counts}), validation – {TEST_FROM}, test from {TEST_FROM}.', '',
        f'Effect of 1 U: −{EFFECT_PER_UNIT} mg/dL in total, along an insulin curve peaking at {EFFECT_CURVE[0]} min and '
        f'done by {EFFECT_CURVE[1]} min (' + ' / '.join(f'{-EFFECT_PER_UNIT * effect[m // 5]:.1f}' for m in (30, 60, 90, 120))
        + ' mg/dL at 30 / 60 / 90 / 120 min).', '',
        '## Accuracy on real data (mg/dL)', '', md(acc), '',
        '## Forecast change for an insulin change (mg/dL, mean)', '',
        '"assumed effect": what the synthetic data builds in. Wrong direction: more insulin raises the forecast or '
        'less lowers it.', '', md(probe), '',
    ])
    (RESULTS / 'synthetic.md').write_text(report)
    print(f'wrote {RESULTS / "synthetic.md"}')


if __name__ == '__main__':
    main()
