"""What-if forecasts: glucose under a given insulin plan, as AAPS's curves are.

    uv run python whatif.py

Compares, for the plans "zero temp" and "profile basal, no boluses":
- AAPS's curve for that plan (ZT, IOB),
- the plain MLP, which does not know the plan,
- a learned plan model: the MLP given the activity of future insulin
  (trained on what was delivered),
- a hybrid: the MLP trained on glucose with the effect of future insulin
  removed (ISF x insulin acted), the plan's effect added back the same way.

Scored on test stretches where the plan was actually followed, and by the
predicted effect of suspending. Writes results/whatif.md.
"""

import time

import numpy as np
import pandas as pd

from glupred import baselines
from glupred.actions import insulin_kernel
from glupred.features import build_features, future_steps
from glupred.load import load_all
from glupred.nn import Model
from glupred.whatif import constant_plan, followed, planned_activity
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

HORIZONS = 48
MINUTES = (30, 60, 120)
EFFECT_MINUTES = (30, 60, 120, 240)


def main():
    grid = grid_cached(False)
    X, Y, info = build_features(grid, rescue={}, horizons=HORIZONS)
    data = load_all()

    ik = insulin_kernel()
    delivered = grid['bolus'].to_numpy() + grid['basal'].to_numpy()
    profile = grid['profile_basal'].to_numpy()
    act = planned_activity(delivered - profile, ik, HORIZONS)

    dec = baselines.aaps_decisions(data['aaps_decisions'], X.index, fill=12)
    isf = dec['isf'].to_numpy()

    valid = (info['valid'].to_numpy() & period(X.index, TRAIN_FROM) & ~np.isnan(act).any(axis=1)
             & ~np.isnan(isf) & (profile > 0))
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)

    g_now = X['g_now'].to_numpy()
    Yn = Y.to_numpy()
    actual = Yn + g_now[:, None]
    mask = info[[f'no_carbs_h{h + 1}' for h in range(HORIZONS)]].to_numpy()
    steps = [k - 1 for k in future_steps(HORIZONS)]
    Xn = X.to_numpy()

    def with_plan(a):
        return np.column_stack([Xn, a[:, steps]])

    Xp = with_plan(act)
    # Glucose had no net insulin been delivered after now; floor it so the
    # log target stays defined (rare: long, deep suspensions).
    effect = isf[:, None] * np.cumsum(act, axis=1)
    Y_adj = np.maximum(Yn + effect, 20 - g_now[:, None])
    print(f'train {tr.sum()}, validation {va.sum()}, test {te.sum()}; '
          f'floored targets: {100 * np.mean(Yn[tr] + effect[tr] < 20 - g_now[tr, None]):.2f}%')

    def fit(Xa, Ya):
        return Model(quantiles=(), events=()).fit(
            Xa[tr], g_now[tr], Ya[tr], mask[tr], None, Xa[va], g_now[va], Ya[va], mask[va], None,
            log=lambda *_: None)

    t = time.time()
    plain = fit(Xn, Yn)
    learned = fit(Xp, Yn)
    hybrid = fit(Xn, Y_adj)
    print(f'trained in {time.time() - t:.0f}s')

    m = te
    g = g_now[m]
    plans = {'zero': constant_plan(-profile[m], ik, HORIZONS), 'profile': np.zeros((m.sum(), HORIZONS)),
             'actual': act[m]}
    hybrid_base = hybrid.predict(Xn[m], g)['mean']
    pred = {'plain': plain.predict(Xn[m], g)['mean']}
    for plan, a in plans.items():
        Xa = Xp[m].copy()
        Xa[:, Xn.shape[1]:] = a[:, steps]
        pred[f'learned {plan}'] = learned.predict(Xa, g)['mean']
        pred[f'hybrid {plan}'] = hybrid_base - isf[m, None] * np.cumsum(a, axis=1)

    curves = baselines.aaps_curves(data['aaps_predictions'], X.index, HORIZONS)
    aaps_zt = curves['ZT'][m]  # trimmed once it rises above target: left as NaN
    aaps_iob = pd.DataFrame(curves['IOB']).ffill(axis=1).to_numpy()[m]

    a_te, mask_te = actual[m], mask[m]

    def errors(rows, label, sel, h, methods):
        for name, P in methods.items():
            err = P[sel, h] - a_te[sel, h]
            rows.append({'plan': label, 'minutes': 5 * (h + 1), 'model': name, 'n': sel.sum(),
                         'MAE': np.mean(np.abs(err)), 'bias': np.mean(err), 'P90': np.percentile(np.abs(err), 90)})

    # --- where the plan was followed (and nothing eaten)
    zero_ok = delivered <= 1e-9
    profile_ok = (np.abs(delivered - profile) <= 0.1 * profile) & (grid['bolus'].to_numpy() == 0)
    follow = {'zero temp': followed(zero_ok, HORIZONS)[m], 'profile basal': followed(profile_ok, HORIZONS)[m]}
    followed_rows = []
    for label, f in follow.items():
        aaps_name, aaps_curve, key = (('AAPS ZT', aaps_zt, 'zero') if label == 'zero temp'
                                      else ('AAPS IOB', aaps_iob, 'profile'))
        methods = {aaps_name: aaps_curve, 'plain MLP (plan unknown)': pred['plain'],
                   f'learned, {label} plan': pred[f'learned {key}'], f'hybrid, {label} plan': pred[f'hybrid {key}']}
        for minutes in MINUTES:
            h = minutes // 5 - 1
            sel = f[:, h] & mask_te[:, h] & np.all([~np.isnan(P[:, h]) for P in methods.values()], axis=0)
            errors(followed_rows, label, sel, h, methods)

    # --- all test samples with the actual delivery as the plan
    all_rows = []
    for minutes in MINUTES + (240,):
        h = minutes // 5 - 1
        errors(all_rows, 'as delivered', mask_te[:, h], h,
               {'plain MLP (plan unknown)': pred['plain'], 'learned, actual plan': pred['learned actual'],
                'hybrid, actual plan': pred['hybrid actual']})

    # --- predicted effect of a zero temp instead of profile basal
    effect_rows = []
    physics = pred['hybrid zero'] - pred['hybrid profile']
    learned_effect = pred['learned zero'] - pred['learned profile']
    aaps_effect = aaps_zt - aaps_iob
    for minutes in EFFECT_MINUTES:
        h = minutes // 5 - 1
        for name, e in (('physics (ISF × insulin not delivered; hybrid)', physics),
                        ('learned plan model', learned_effect), ('AAPS ZT − IOB', aaps_effect)):
            v = e[:, h][~np.isnan(e[:, h])]
            if not len(v):  # AAPS curves stop at 235 min
                continue
            effect_rows.append({'minutes': minutes, 'model': name, 'n': len(v), 'median': np.median(v),
                                'mean': np.mean(v), '10th percentile': np.percentile(v, 10),
                                '90th percentile': np.percentile(v, 90),
                                'suspending lowers glucose %': 100 * np.mean(v < 0)})
        ok = ~np.isnan(aaps_effect[:, h])
        effect_rows.append({'minutes': minutes, 'model': 'learned / physics (mean ratio)', 'n': len(learned_effect),
                            'mean': np.mean(learned_effect[:, h]) / np.mean(physics[:, h])})
        if ok.any():
            effect_rows.append({'minutes': minutes, 'model': 'AAPS / physics, same samples (mean ratio)',
                                'n': ok.sum(), 'mean': np.mean(aaps_effect[ok, h]) / np.mean(physics[ok, h])})

    def table(rows, index):
        return pd.DataFrame(rows).set_index(index).round(2 if index == ['minutes', 'model'] else 1).to_markdown()

    report = [
        '# What-if forecasts: glucose under an insulin plan', '',
        f'Generated {pd.Timestamp.now(tz="UTC"):%Y-%m-%d %H:%M} UTC by `modelling/whatif.py`. '
        f'Test: {TEST_FROM} – end, {te.sum()} samples.', '',
        '## Accuracy where the plan was followed', '',
        'Samples where delivery matched the plan from now up to the horizon, with no new carbs. '
        'Zero temp: nothing delivered. Profile basal: within 10% of it, no bolus. '
        'Only samples where every method has a value (AAPS ZT ends once it rises above target).', '',
        table(followed_rows, ['plan', 'minutes', 'model']), '',
        '## Accuracy with the delivered insulin as the plan (all test samples, no new carbs)', '',
        table(all_rows, ['minutes', 'model']), '',
        '## Predicted effect of a zero temp instead of profile basal (mg/dL)', '',
        'Positive: suspending is predicted to raise glucose by that much at the horizon.', '',
        table(effect_rows, ['minutes', 'model']), '',
    ]
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / 'whatif.md').write_text('\n'.join(report))
    print('\n'.join(report))


if __name__ == '__main__':
    main()
