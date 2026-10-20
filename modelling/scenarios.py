"""Trains the multi-output model and scores dosing, eat-now and high scenarios.

    uv run python scenarios.py [--no-rescue] [--no-mask] [--grams 15]

Trains on TRAIN, stops early and picks thresholds on VALIDATION, reports
on TEST. Writes results/scenarios.md.
"""

import argparse
import time

import numpy as np
import pandas as pd

from glupred import baselines
from glupred.features import build_features, interpolate
from glupred.load import load_all
from glupred.metrics import summarize
from glupred.nn import Model
from glupred.scenarios import (
    DOSING_WINDOWS, EVENTUAL_SLOTS, GUARD_SLOTS, TARGET_LOW, WARNING_SLOTS, crossings, decision_row, dosing_event,
    dosing_row, eventual_event, guard_event, high_event, low_event, threshold_for_recall, warning_episodes)
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

HORIZONS = 48  # 4 h
ACCURACY_MINUTES = (30, 60, 120, 180, 240)
# High warnings: (level mg/dL, window slots).
HIGHS = ((180, 6), (250, 12))
LOW_METHODS = ('persistence', 'linear trend 15m', 'AAPS IOB', 'MLP mean', 'MLP 25th percentile', 'MLP 10th percentile')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-rescue', action='store_true', help='do not assume unlogged rescue carbs')
    ap.add_argument('--no-mask', action='store_true', help='train on targets after new carbs too')
    ap.add_argument('--grams', type=float, default=15.0, help='assumed rescue carbs')
    args = ap.parse_args()

    grid = grid_cached(False)
    X, Y, info = build_features(grid, rescue=None if args.no_rescue else {'grams': args.grams}, horizons=HORIZONS)
    valid = info['valid'].to_numpy() & period(X.index, TRAIN_FROM)
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    print(f'train {tr.sum()}, validation {va.sum()}, test {te.sum()}; '
          f'assumed rescue carbs: {(info["assumed_carbs"] > 0).sum()} lows')

    g_now = X['g_now'].to_numpy()
    actual = Y.to_numpy() + g_now[:, None]
    mask = info[[f'no_carbs_h{h + 1}' for h in range(HORIZONS)]].to_numpy()
    if args.no_mask:
        mask = np.ones_like(mask)
    events = np.column_stack([dosing_event(actual, w) for w in DOSING_WINDOWS]
                             + [low_event(actual, g_now)]
                             + [high_event(actual, g_now, lv, w) for lv, w in HIGHS]
                             + [guard_event(actual, g_now), eventual_event(actual)]).astype(np.float32)
    event_names = (tuple(f'p_below_target_{w // 12}h' for w in DOSING_WINDOWS) + ('p_low_30',)
                   + tuple(f'p_high_{lv}_{5 * w}' for lv, w in HIGHS) + ('p_low_4h', 'p_eventual_below_target'))

    Xn = X.to_numpy()
    t = time.time()
    model = Model(quantiles=(0.1, 0.25, 0.75, 0.9), events=event_names).fit(
        Xn[tr], g_now[tr], Y.to_numpy()[tr], mask[tr], events[tr],
        Xn[va], g_now[va], Y.to_numpy()[va], mask[va], events[va])
    print(f'trained in {time.time() - t:.0f}s')
    pred = {name: model.predict(Xn[m], g_now[m]) for name, m in (('val', va), ('test', te))}

    data = load_all()
    # AAPS trims a curve once it levels off: continue it flat.
    curves = baselines.aaps_curves(data['aaps_predictions'], X.index, HORIZONS)
    curves = {k: pd.DataFrame(v).ffill(axis=1).to_numpy() for k, v in curves.items()}

    def predictions(split, m):
        """Glucose paths (n, HORIZONS) per method, and classifier scores."""
        p = pred[split]
        trend = baselines.linear_trend(X[m], horizons=HORIZONS) + g_now[m, None]
        return {
            'persistence': np.repeat(g_now[m, None], HORIZONS, axis=1),
            'linear trend 15m': trend,
            'AAPS IOB': curves['IOB'][m],
            'AAPS auto': curves['auto'][m],
            'MLP mean': p['mean'],
            'MLP 25th percentile': p['q0.25'],
            'MLP 10th percentile': p['q0.1'],
            'MLP 75th percentile': p['q0.75'],
            'MLP 90th percentile': p['q0.9'],
        }, p

    paths = {s: predictions(s, m) for s, m in (('val', va), ('test', te))}

    # --- regression accuracy (all samples; and only where nothing is eaten)
    acc_rows = []
    for name, P in paths['test'][0].items():
        ok = ~np.isnan(P).any(axis=1)
        acc_rows.append(summarize(name, actual[te][ok], P[ok], ACCURACY_MINUTES, ACCURACY_MINUTES))
    no_carbs = mask[te].all(axis=1)
    for name in ('persistence', 'MLP mean'):
        P = paths['test'][0][name]
        acc_rows.append(summarize(f'{name}, no new carbs (n={no_carbs.sum()})', actual[te][no_carbs], P[no_carbs],
                                  ACCURACY_MINUTES, ACCURACY_MINUTES))

    # --- scenario A: dosing, samples at or above the target's lower end
    dose_rows = []
    pop = {s: g_now[m] >= TARGET_LOW for s, m in (('val', va), ('test', te))}

    def dosing_scores(split, w):
        P, p = paths[split]
        s = {name: -np.min(v[:, :w], axis=1) for name, v in P.items() if name in LOW_METHODS}
        s[f'MLP P(below target in {w // 12} h)'] = p[f'p_below_target_{w // 12}h']
        return s

    for w in DOSING_WINDOWS:
        ev = {s: dosing_event(actual[m], w) for s, m in (('val', va), ('test', te))}
        sv, st = dosing_scores('val', w), dosing_scores('test', w)
        for target in (0.9, 0.95):
            for name in st:
                okv = pop['val'] & ~np.isnan(sv[name])
                okt = pop['test'] & ~np.isnan(st[name])
                thr = threshold_for_recall(sv[name][okv], ev['val'][okv], target)
                dose_rows.append(dosing_row(name, st[name][okt], ev['test'][okt], actual[te][okt], thr, target, w))

    # --- scenario A as AAPS decides it: suspend (zero temp) when minGuardBG
    # is below its threshold; lower the temp when eventualBG is below target.
    glucose = interpolate(grid['glucose'].to_numpy(), 2)
    lows_all = crossings(glucose)
    dec = baselines.aaps_decisions(data['aaps_decisions'], X.index)
    a, b = EVENTUAL_SLOTS
    test_lows = lows_all[te[np.maximum(lows_all - 1, 0)] & (lows_all > np.where(te)[0][0])]
    # Carbs eaten (logged or assumed rescue) in the next 1 or 4 h, per test sample.
    eaten = np.concatenate([[0.0], np.cumsum(grid['carbs'].to_numpy() + info['assumed_carbs'].to_numpy())])
    te_idx = np.where(te)[0]
    carbs_ahead = {f'{k // 12} h': eaten[np.minimum(te_idx + 1 + k, len(eaten) - 1)] - eaten[te_idx + 1] > 0
                   for k in (12, GUARD_SLOTS)}

    def decision_inputs(split, m):
        P, p = paths[split]
        return {
            'suspend': {
                'MLP mean, 4 h minimum': -np.min(P['MLP mean'][:, :GUARD_SLOTS], axis=1),
                'MLP 10th percentile, 4 h minimum': -np.min(P['MLP 10th percentile'][:, :GUARD_SLOTS], axis=1),
                'MLP P(below 70 within 4 h)': p['p_low_4h'],
            },
            'reduce': {
                'MLP mean, 3–4 h': -np.mean(P['MLP mean'][:, a:b], axis=1),
                'MLP 25th percentile, 3–4 h': -np.mean(P['MLP 25th percentile'][:, a:b], axis=1),
                'MLP P(3–4 h mean below target)': p['p_eventual_below_target'],
            },
        }

    inputs = {s: decision_inputs(s, m) for s, m in (('val', va), ('test', te))}
    aaps_flag = {s: {'suspend': dec['lgs'].to_numpy()[m] == 1,
                     'reduce': dec['eventual'].to_numpy()[m] < TARGET_LOW} for s, m in (('val', va), ('test', te))}
    aaps_label = {'suspend': 'AAPS as run: minGuardBG < threshold', 'reduce': f'AAPS as run: eventualBG < {TARGET_LOW}'}
    decision_rows = {'suspend': [], 'reduce': []}
    for kind in ('suspend', 'reduce'):
        ev, pop = {}, {}
        for s, m in (('val', va), ('test', te)):
            ev[s] = guard_event(actual[m], g_now[m]) if kind == 'suspend' else eventual_event(actual[m])
            known = ~np.isnan(dec['min_guard'].to_numpy()[m]) & ~np.isnan(dec['eventual'].to_numpy()[m])
            pop[s] = known & (g_now[m] >= 70) if kind == 'suspend' else known

        def row(name, flag_test, point):
            full = np.zeros(len(X), dtype=bool)
            full[np.where(te)[0][pop['test']]] = flag_test
            carbs = {k: v[pop['test']] for k, v in carbs_ahead.items()}
            return {'operating point': point,
                    **decision_row(name, flag_test, ev['test'][pop['test']], full, test_lows, carbs)}

        fv, ft = aaps_flag['val'][kind][pop['val']], aaps_flag['test'][kind][pop['test']]
        decision_rows[kind].append(row('always on (base rate)', np.ones_like(ft), 'reference'))
        decision_rows[kind].append(row(aaps_label[kind], ft, 'as run'))
        rate, recall = fv.mean(), fv[ev['val'][pop['val']]].mean()
        for name in inputs['test'][kind]:
            sv = np.nan_to_num(inputs['val'][kind][name][pop['val']], nan=-np.inf)
            st = np.nan_to_num(inputs['test'][kind][name][pop['test']], nan=-np.inf)
            for point, thr in ((f'same time on as AAPS ({100 * rate:.0f}%)', np.quantile(sv, 1 - rate)),
                               (f'same recall as AAPS ({100 * recall:.0f}%)',
                                threshold_for_recall(sv, ev['val'][pop['val']], recall))):
                decision_rows[kind].append(row(name, st >= thr, point))

    # How good are the numbers AAPS decides on? Against the actual 4 h
    # minimum and 3–4 h mean.
    value_rows = []
    pt = paths['test'][0]
    d_te = dec[te]
    actual_min = np.min(actual[te][:, :GUARD_SLOTS], axis=1)
    actual_eventual = np.mean(actual[te][:, a:b], axis=1)
    for target_name, truth, estimates in (
            ('4 h minimum', actual_min, {
                'AAPS minGuardBG': d_te['min_guard'].to_numpy(), 'AAPS minPredBG': d_te['min_pred'].to_numpy(),
                'MLP mean': np.min(pt['MLP mean'][:, :GUARD_SLOTS], axis=1),
                'MLP 10th percentile': np.min(pt['MLP 10th percentile'][:, :GUARD_SLOTS], axis=1)}),
            ('3–4 h mean', actual_eventual, {
                'AAPS eventualBG': d_te['eventual'].to_numpy(),
                'MLP mean': np.mean(pt['MLP mean'][:, a:b], axis=1)})):
        for name, est in estimates.items():
            for case, sel in (('all', np.ones(len(truth), dtype=bool)), ('actual < 70', truth < 70),
                              ('actual 70–180', (truth >= 70) & (truth <= 180))):
                sel = sel & ~np.isnan(est)
                err = est[sel] - truth[sel]
                value_rows.append({'value': target_name, 'model': name, 'case': case, 'n': sel.sum(),
                                   'MAE': np.mean(np.abs(err)), 'bias': np.mean(err),
                                   'P90': np.percentile(np.abs(err), 90)})

    # --- scenario B: eat-now warning, scored per low and per alarm
    weeks = {s: m.sum() * 5 / 60 / 24 / 7 for s, m in (('val', va), ('test', te))}
    warn_rows, chosen = [], {}

    def warning_scores(split):
        P, p = paths[split]
        s = {name: -np.min(v[:, :WARNING_SLOTS], axis=1) for name, v in P.items()
             if name in LOW_METHODS and name != 'persistence'}
        s['MLP P(low in 30 min)'] = p['p_low_30']
        return s

    wv, wt = warning_scores('val'), warning_scores('test')

    def episodes(split, m, score, thr, events_all=lows_all, armed=None, slots=WARNING_SLOTS):
        """Episode scores for warning when score >= thr; `armed` (per sample in
        m) says when a warning is possible (default: glucose at or above 70)."""
        warn = np.zeros(len(X), dtype=bool)
        idx = np.where(m)[0]
        warn[idx] = (score >= thr) & (g_now[m] >= 70 if armed is None else armed)
        start, end = idx[0], idx[-1]
        ev = events_all[(events_all > start) & (events_all <= end) & m[np.maximum(events_all - 1, 0)]]
        return warning_episodes(warn, ev, weeks[split], slots)

    for name in wt:
        sv_, st_ = np.nan_to_num(wv[name], nan=-np.inf), np.nan_to_num(wt[name], nan=-np.inf)
        candidates = np.unique(np.quantile(sv_[np.isfinite(sv_)], np.linspace(0.80, 0.999, 60)))
        best = max(candidates, key=lambda c: episodes('val', va, sv_, c)['F1'])
        chosen[name] = best
        warn_rows.append({'model': name, 'threshold': best if name.startswith('MLP P') else -best,
                          **episodes('test', te, st_, best)})

    # Operating points of the classifier, for picking a trade-off.
    point_rows = []
    for thr in (0.2, 0.3, 0.4, 0.5, 0.6):
        point_rows.append({'P(low in 30 min) ≥': thr, **episodes('test', te, wt['MLP P(low in 30 min)'], thr)})

    # --- highs
    P_te = paths['test'][0]
    a_te, g_te = actual[te], g_now[te]
    high_methods = ('persistence', 'AAPS IOB', 'AAPS auto', 'MLP mean')

    # Accuracy for high actual glucose, and while coming down from a high.
    high_acc = []
    for m in (30, 60, 120):
        h = m // 5 - 1
        for name in high_methods:
            P = P_te[name]
            for label, sel in ((f'actual 180–250', (a_te[:, h] >= 180) & (a_te[:, h] < 250)),
                               (f'actual > 250', a_te[:, h] >= 250),
                               ('now > 180', g_te > 180)):
                sel = sel & ~np.isnan(P[:, h])
                err = P[sel, h] - a_te[sel, h]
                high_acc.append({'minutes': m, 'case': label, 'model': name, 'share%': 100 * sel.mean(),
                                 'MAE': np.mean(np.abs(err)), 'bias': np.mean(err),
                                 'P90': np.percentile(np.abs(err), 90),
                                 'over by > 40 %': 100 * np.mean(err > 40), 'under by > 40 %': 100 * np.mean(err < -40)})

    # High episodes: how often, how long, and with or without logged carbs.
    carbs_logged = grid['carbs'].to_numpy()
    cs = np.concatenate([[0.0], np.cumsum(carbs_logged)])
    test_slots = period(X.index, TEST_FROM)
    episode_rows = []
    for level in (180, 250):
        ups = crossings(glucose, level, rising=True)
        ups = ups[test_slots[ups]]
        meal = cs[ups + 1] - cs[np.maximum(ups - 24, 0)] > 0  # carbs logged in the 2 h before
        above = glucose > level
        # Duration: slots until glucose is back at or below the level.
        durations = []
        for u in ups:
            e = u
            while e < len(glucose) and (above[e] or np.isnan(glucose[e])) and e - u < 288:
                e += 1
            durations.append(5 * (e - u))
        weeks_all = test_slots.sum() * 5 / 60 / 24 / 7
        episode_rows.append({
            'level': f'> {level}', 'per week': len(ups) / weeks_all,
            'with carbs logged in the 2 h before %': 100 * meal.mean(),
            'median minutes above': np.median(durations),
            'time above, % of test period': 100 * np.nanmean(above[test_slots]),
        })

    # High warnings, scored like the low warning.
    high_warn_rows, high_point_rows = [], []
    for level, w in HIGHS:
        ups_all = crossings(glucose, level, rising=True)
        armed = {s: g_now[m] <= level for s, m in (('val', va), ('test', te))}

        def scores(split):
            P, p = paths[split]
            s = {name: np.max(v[:, :w], axis=1) for name, v in P.items()
                 if name in ('linear trend 15m', 'AAPS IOB', 'AAPS auto', 'MLP mean', 'MLP 75th percentile', 'MLP 90th percentile')}
            s[f'MLP P(> {level} in {5 * w} min)'] = p[f'p_high_{level}_{5 * w}']
            return s

        hv, ht = scores('val'), scores('test')
        for name in ht:
            sv_, st_ = np.nan_to_num(hv[name], nan=-np.inf), np.nan_to_num(ht[name], nan=-np.inf)
            cands = np.unique(np.quantile(sv_[np.isfinite(sv_)], np.linspace(0.5, 0.999, 60)))
            best = max(cands, key=lambda c: episodes('val', va, sv_, c, ups_all, armed['val'], w)['F1'])
            high_warn_rows.append({'event': f'> {level} within {5 * w} min', 'model': name, 'threshold': best,
                                   **episodes('test', te, st_, best, ups_all, armed['test'], w)})
        for thr in (0.3, 0.4, 0.5, 0.6, 0.7):
            high_point_rows.append({'event': f'> {level} within {5 * w} min', 'P ≥': thr,
                                    **episodes('test', te, ht[f'MLP P(> {level} in {5 * w} min)'], thr,
                                               ups_all, armed['test'], w)})

    # Acting on a predicted high: correcting because glucose is predicted
    # above 180 in 1 or 2 h, while it is 100–180 now.
    act_rows = []
    in_range = (g_te >= 100) & (g_te <= 180)
    for m in (60, 120):
        h = m // 5 - 1
        for name in ('AAPS IOB', 'AAPS auto', 'MLP mean', 'MLP 75th percentile', 'MLP 90th percentile'):
            P = P_te[name]
            said = in_range & ~np.isnan(P[:, h]) & (P[:, h] > 180)
            went_high = in_range & (a_te[:, h] > 180)
            act_rows.append({
                'minutes': m, 'model': name, 'predicted > 180, % of in-range time': 100 * said.sum() / in_range.sum(),
                'actually > 180 %': 100 * np.mean(a_te[said, h] > 180),
                'actually < 140 %': 100 * np.mean(a_te[said, h] < 140),
                'went < 70 before %': 100 * np.mean(np.min(a_te[said, :h + 1], axis=1) < 70),
                'highs predicted %': 100 * np.sum(said & went_high) / max(1, went_high.sum()),
            })

    def table(rows, index='model'):
        return pd.DataFrame(rows).set_index(index).round(1).to_markdown()

    acc_cols = ['n'] + [c for m in ACCURACY_MINUTES for c in (f'MAE{m}', f'P90_{m}', f'MARD{m}%', f'A{m}%')]
    acc = pd.DataFrame(acc_rows).set_index('model')[acc_cols].round(1).to_markdown()
    report = [
        '# Glucose prediction: dosing and eat-now scenarios', '',
        f'Generated {pd.Timestamp.now(tz="UTC"):%Y-%m-%d %H:%M} UTC by `modelling/scenarios.py` '
        f'({"no assumed rescue carbs" if args.no_rescue else f"assumed rescue carbs {args.grams:g} g"}, '
        f'{"unmasked" if args.no_mask else "targets after new carbs ignored"}).', '',
        f'Trained on {TRAIN_FROM} – {VALIDATION_FROM}, thresholds picked on {VALIDATION_FROM} – {TEST_FROM}, '
        f'scored on {TEST_FROM} – end ({te.sum()} samples, {weeks["test"]:.0f} weeks of valid data).', '',
        '## Prediction accuracy (test)', '', acc, '',
        f'## Dosing: suspend if glucose is predicted below {TARGET_LOW} mg/dL within 1–4 h', '',
        f'Samples at or above {TARGET_LOW} mg/dL. Threshold set on validation to catch 90% / 95% of events.', '',
        table(dose_rows), '',
        '## Dosing as AAPS decides it', '',
        f'Outcomes: suspend is for glucose falling below 70 within {GUARD_SLOTS // 12} h (samples at or above 70); '
        f'reduce is for the {a // 12}–{b // 12} h mean below {TARGET_LOW}. AAPS rows use its logged decision values; '
        'other rows use a threshold set on validation to match AAPS either in time on or in events caught. '
        'AAPS suspensions prevent some lows, so its "without event" share is overstated.', '',
        '### Suspend', '', table(decision_rows['suspend'], ['operating point', 'model']), '',
        '### Reduce insulin', '', table(decision_rows['reduce'], ['operating point', 'model']), '',
        '### Accuracy of the decision values (test)', '', 'Bias: estimate − actual.', '',
        table(value_rows, ['value', 'model', 'case']), '',
        '## Eat-now warning: glucose below 70 within 30 min', '',
        'Threshold per method chosen on validation for the best F1 of lows announced and alarms followed by a low.',
        'Threshold: predicted minimum (mg/dL) or probability.', '',
        table(warn_rows), '',
        '### Classifier operating points (test)', '', table(point_rows, 'P(low in 30 min) ≥'), '',
        '## Highs', '',
        '### High episodes (test period)', '', table(episode_rows, 'level'), '',
        '### Accuracy when glucose is high (test)', '',
        'Bias: predicted − actual (negative: predicted too low).', '',
        table(high_acc, ['minutes', 'case', 'model']), '',
        '### High warnings', '',
        'Warn when the predicted maximum (mg/dL) or probability crosses the threshold, while glucose is still '
        'at or below the level; threshold chosen on validation for the best F1.', '',
        table(high_warn_rows, ['event', 'model']), '',
        '### High warning classifier operating points (test)', '', table(high_point_rows, ['event', 'P ≥']), '',
        '### Acting on a predicted high (now 100–180)', '',
        'How often a predicted high above 180 in 1 or 2 h came true, stayed below 140, or was preceded by a low.', '',
        table(act_rows, ['minutes', 'model']), '',
    ]
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / 'scenarios.md').write_text('\n'.join(report))
    print('\n'.join(report))


if __name__ == '__main__':
    main()
