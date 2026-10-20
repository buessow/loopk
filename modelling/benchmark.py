"""The standard benchmark for glucose forecasts (glupred/benchmark.py).

    uv run python benchmark.py [--candidates server,all-level-synthetic]

Trains each candidate in CANDIDATES on TRAIN (stopped early and calibrated
on VALIDATION), scores it on TEST with the standard scorecard, and saves
the result to results/benchmark/<candidate>.json. The report,
results/benchmark.md, compares the scorecards of every saved run, from
this and earlier runs, with "no change" and AAPS; details follow for the
candidates run now. A new kind of model is benchmarked by adding it to
CANDIDATES.
"""

import argparse
import json

import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from export import INPUTS as SERVER_INPUTS
from glupred import baselines
from glupred import benchmark as bm
from glupred.features import ACTIVITY_LAGS, LEVEL_DAYS, SPORT_HOURS, build_features, future_steps
from glupred.load import load
from glupred.nn import Model
from glupred.scenarios import low_event
from glupred.synthetic import copies, moments
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

HORIZONS = 24
LEVEL = [f'g_mean_{d}d' for d in LEVEL_DAYS]
SPORT = [f'sport_{h}h' for h in SPORT_HOURS] + ['sport_since_h', 'sport_hr_1h']
RUNS = RESULTS / 'benchmark'

# name: model ('mlp' as in glupred/nn.py, or 'ridge' / 'gbm' as in
# train.py), inputs ('server' or 'all', + level; 'server' + 'insulin' /
# 'carbs': their activity, on board, and the profile basal), horizons,
# targets only where nothing more is eaten (MLP), synthetic insulin copies
# (MLP)
CANDIDATES = {
    'ridge': {'model': 'ridge', 'inputs': 'all', 'level': False, 'horizons': 24},
    'gbm': {'model': 'gbm', 'inputs': 'all', 'level': False, 'horizons': 24},
    'server': {'inputs': 'server', 'level': False, 'horizons': 6, 'no_carbs': False, 'synthetic': ()},
    'server-level': {'inputs': 'server', 'level': True, 'horizons': 6, 'no_carbs': False, 'synthetic': ()},
    'all-level': {'inputs': 'all', 'level': True, 'horizons': 24, 'no_carbs': True, 'synthetic': ()},
    'all-level-synthetic': {'inputs': 'all', 'level': True, 'horizons': 24, 'no_carbs': True,
                            'synthetic': ('random', 'peak', 'meal')},
    'server-insulin-synthetic': {'inputs': 'server', 'level': True, 'insulin': True, 'horizons': 6,
                                 'no_carbs': False, 'synthetic': ('random', 'peak', 'meal')},
    'server-insulin-carbs-synthetic': {'inputs': 'server', 'level': True, 'insulin': True, 'carbs': True,
                                       'horizons': 6, 'no_carbs': False, 'synthetic': ('random', 'peak', 'meal')},
}
QUANTILES = (0.1, 0.9)
TIE = 1e-3  # weight of the window mean in warning scores
EVENTS = ('p_low_30',)
GBM_SLOTS = (1, 2, 3, 4, 5, 6, 9, 12, 18, 24)  # horizons fitted; the others interpolated


class Trained:
    def __init__(self, columns, model):
        self.columns, self.model = columns, model

    def predict(self, X, g):
        return self.model.predict(X, g)


class Regression:
    """Ridge or gradient boosting on the glucose deltas (as train.py), one
    output per fitted horizon, interpolated between them."""

    def __init__(self, kind, slots):
        self.kind, self.slots = kind, slots

    def fit(self, X, Y):
        if self.kind == 'ridge':
            self.models = [make_pipeline(StandardScaler(), Ridge(alpha=10.0)).fit(X, Y[:, [s - 1 for s in self.slots]])]
        else:
            self.models = [HistGradientBoostingRegressor(max_iter=300, learning_rate=0.1, max_leaf_nodes=63,
                                                         early_stopping=True, random_state=1).fit(X, Y[:, s - 1])
                           for s in self.slots]
        return self

    def predict(self, X, g):
        d = (self.models[0].predict(X) if self.kind == 'ridge'
             else np.column_stack([m.predict(X) for m in self.models]))
        h = np.arange(1, HORIZONS + 1)
        d = np.stack([np.interp(h, self.slots, row) for row in d])
        return {'mean': d + g[:, None]}


def activity_inputs(prefix, on_board, horizons):
    return ([f'{prefix}_past_{lag}' for lag in ACTIVITY_LAGS] + [f'{prefix}_fut_{k}' for k in future_steps(horizons)]
            + [on_board])


def train(data, spec, tr, va):
    X = data.X
    H = spec['horizons']
    base = SERVER_INPUTS if spec['inputs'] == 'server' else [c for c in X.columns if c not in LEVEL + SPORT]
    columns = base + (LEVEL if spec['level'] else [])
    if spec.get('insulin'):
        columns += activity_inputs('ia', 'iob', H) + ['profile_basal']
    if spec.get('carbs'):
        columns += activity_inputs('ca', 'cob', H)
    idx = [data.cols.index(c) for c in columns]
    if spec.get('model', 'mlp') != 'mlp':
        slots = list(range(1, H + 1)) if spec['model'] == 'ridge' else list(GBM_SLOTS)
        return Trained(columns, Regression(spec['model'], slots).fit(data.Xn[tr][:, idx], data.Y[tr]))
    mask = data.mask[:, :H] if spec['no_carbs'] else np.ones((len(X), H), dtype=bool)

    def part(sel):
        rows = [(data.Xn[sel][:, idx], data.g[sel], data.Y[sel, :H], mask[sel],
                 low_event(data.actual[sel], data.g[sel])[:, None].astype(np.float32))]
        for s, kind in enumerate(spec['synthetic']):
            xs, ys, j = copies(kind, X, data.Y, sel, data.m, 1 + s + 10 * int(sel is va), HORIZONS)
            g = xs[:, 0]
            rows.append((xs[:, idx], g, ys[:, :H], mask[j], low_event(ys + g[:, None], g)[:, None].astype(np.float32)))
        return [np.concatenate(p) for p in zip(*rows)]

    model = Model(quantiles=QUANTILES, events=EVENTS).fit(*part(tr), *part(va), log=lambda *_: None)
    return Trained(columns, model)


def scorecard(name, acc, situations, warn, resp, stab, drift):
    a = acc[(acc['samples'] == 'all') & (acc['model'] == name)].iloc[0]
    card = {'model': name}
    for m in bm.MINUTES:
        card[f'MAE {m}m'] = a.get(f'MAE {m}m')
    for m in (30, 60):
        card[f'skill {m}m %'] = a.get(f'skill {m}m %')
        card[f'bias {m}m'] = a.get(f'bias {m}m')
    card['P90 60m'] = a.get('P90 60m')
    for event, source in (('< 70 within 15 min', 'forecast'), ('< 70 within 30 min', 'forecast'),
                          ('< 70 within 30 min', 'low probability'), (f'> {bm.HIGH} within 30 min', 'forecast')):
        w = warn[(warn['model'] == name) & (warn['warning'] == event) & (warn['warning from'] == source)]
        label = f'warning {event} ({source})'
        for threshold, short in (('own threshold', 'own'), (f'{bm.ALARMS_PER_WEEK} alarms / week', f'{bm.ALARMS_PER_WEEK}/week')):
            r = w[w['threshold'] == threshold]
            if len(r):
                card[f'{label}: caught %, {short}'] = r.iloc[0]['caught %']
                card[f'{label}: alarms correct %, {short}'] = r.iloc[0]['alarms correct %']
                if short == 'own':
                    card[f'{label}: alarms / week, own'] = r.iloc[0]['alarms per week']
    if resp is not None and len(resp):
        r = resp.set_index('change')
        r = r.reindex(columns=list(r.columns) + [c for c in ('30m', '60m', 'expected 30m', 'expected 60m')
                                                 if c not in r.columns])
        if '+2 U now' in r.index:
            card['+2 U now: wrong direction %'] = r.loc['+2 U now', 'wrong direction %']
            card['+2 U now: 30m change / expected'] = r.loc['+2 U now', '30m'] / r.loc['+2 U now', 'expected 30m']
            card['+2 U now: 60m change / expected'] = r.loc['+2 U now', '60m'] / r.loc['+2 U now', 'expected 60m']
            card['+2 U 1 h ago: 60m change / expected'] = r.loc['+2 U 1 h ago', '60m'] / r.loc['+2 U 1 h ago', 'expected 60m']
            card['meal bolus removed: 60m change'] = r.loc['meal bolus removed', '60m']
            card['meal bolus removed: 30m change'] = r.loc['meal bolus removed', '30m']
        if '+20 g carbs now' in r.index:
            card['+20 g carbs: 60m change'] = r.loc['+20 g carbs now', '60m']
            card['+20 g carbs: 30m change'] = r.loc['+20 g carbs now', '30m']
            card['+20 g carbs: wrong direction %'] = r.loc['+20 g carbs now', 'wrong direction %']
        ex = [k for k in r.index if k.startswith('30 min at heart rate')]
        if ex:
            card['exercise: 60m change'] = r.loc[ex[0], '60m']
    if stab:
        card['revision of the 30m forecast in 5 min'] = stab.get('revision of the 30m forecast in 5 min')
        card['80% band holds 30m %'] = stab.get('80% band holds 30m %')
    if drift is not None and len(drift):
        card['largest |bias 30m| per half-year'] = drift['bias 30m'].abs().max()
    low = situations[(situations['model'] == name) & (situations['minutes'] == 30) & (situations['situation'] == 'actual < 70')]
    if len(low):
        card['MAE 30m when actual < 70'] = low.iloc[0]['MAE']
    return {k: (None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v) if not isinstance(v, str) else v)
            for k, v in card.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--candidates', default=','.join(CANDIDATES))
    names = [c for c in ap.parse_args().candidates.split(',') if c]
    grid = grid_cached(False)
    X, Y, info = build_features(grid, rescue={}, horizons=HORIZONS, level=True, sport=True)
    valid = info['valid'].to_numpy() & period(X.index, TRAIN_FROM)
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    curves = baselines.aaps_curves(load('aaps_predictions'), X.index, HORIZONS)
    data = bm.Data(grid, X, Y, info, te, {'IOB': curves['IOB'], 'display': curves['auto']}, moments(grid, X))
    test_idx = np.where(te)[0]
    in_common = data.common[test_idx]
    print(f'test {te.sum()} slots, {data.common.sum()} with an AAPS IOB curve; lows {len(data.lows)}, '
          f'highs > {bm.HIGH} {len(data.highs)}', flush=True)

    trend = baselines.linear_trend(X, horizons=HORIZONS) + data.g[:, None]
    reference = {'no change': np.repeat(data.g[:, None], HORIZONS, axis=1), 'linear trend 15 min': trend,
                 'AAPS IOB': curves['IOB'], 'AAPS display curve': curves['auto'], 'AAPS ZT': curves['ZT'],
                 'AAPS UAM': curves['UAM']}
    preds = {name: r[data.common] for name, r in reference.items()}
    full = {}
    n = len(X)

    def grid_score(values):
        s = np.full(n, np.nan)
        s[test_idx] = values
        return s

    def forecast_warnings(name, mean):
        # Lowest (highest) forecast within the window, over the values a curve
        # has (AAPS's ZT stops once above target); ties, as at AAPS's floor of
        # 39, broken by the mean over the window.
        out = []
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)
            for minutes in (15, 30):
                w = mean[:, :minutes // 5]
                out.append({'model': name, 'warning': 'forecast', 'kind': 'low', 'minutes': minutes, 'own': -70.0,
                            'score': grid_score(-np.nanmin(w, axis=1) - TIE * np.nanmean(w, axis=1))})
            w = mean[:, :bm.WARN_SLOTS]
            out.append({'model': name, 'warning': 'forecast', 'kind': 'high', 'minutes': 30, 'own': float(bm.HIGH),
                        'score': grid_score(np.nanmax(w, axis=1) + TIE * np.nanmean(w, axis=1))})
        return out

    scores = []
    for name, r in reference.items():
        full[name] = {'mean': r[test_idx]}
        if name != 'no change':
            scores += forecast_warnings(name, r[test_idx])
    trained = {}
    for name in names:
        print(f'training {name}', flush=True)
        t = train(data, CANDIDATES[name], tr, va)
        trained[name] = t
        out = t.predict(data.inputs(t)[test_idx], data.g[test_idx])
        full[name] = out
        preds[name] = out['mean'][in_common]
        scores += forecast_warnings(name, out['mean'])
        if 'p_low_30' in out:
            scores.append({'model': name, 'warning': 'low probability', 'kind': 'low', 'minutes': 30,
                           'own': bm.LOW_PROBABILITY, 'score': grid_score(out['p_low_30'])})

    acc = bm.accuracy(data, preds)
    situations = bm.by_situation(data, preds)
    warn = bm.warnings(data, scores)
    print(acc.round(1).to_markdown(index=False), flush=True)

    RUNS.mkdir(parents=True, exist_ok=True)
    details = []
    for name in list(reference) + names:
        resp = bm.responses(data, trained[name]) if name in trained else None
        stab = bm.stability(data, name, full[name]) if name in full else None
        drift = bm.drift(data, name, full[name]) if name in full else None
        card = scorecard(name, acc, situations, warn, resp, stab, drift)
        record = {'run': f'{pd.Timestamp.now(tz="UTC"):%Y-%m-%d %H:%M}', 'test': f'{TEST_FROM} –',
                  'spec': CANDIDATES.get(name), 'scorecard': card}
        (RUNS / f'{name.replace(" ", "-").lower()}.json').write_text(json.dumps(record, indent=2, default=str))
        if name in trained:
            details += [f'### {name}', '', 'Response:', '', resp.round(1).to_markdown(index=False), '',
                        'Stability and band:', '', pd.DataFrame([stab]).round(1).to_markdown(index=False), '',
                        'Bias by half-year:', '', drift.round(1).to_markdown(index=False), '']
        print(card, flush=True)

    saved = [json.loads(p.read_text()) for p in sorted(RUNS.glob('*.json'))]
    cards = pd.DataFrame([r['scorecard'] for r in saved]).set_index('model').astype(float).round(1)
    cards.insert(0, 'run', [r['run'] for r in saved])
    cards = cards.T
    md = lambda d: d.round(1).to_markdown(index=False)
    report = '\n'.join([
        '# Forecast benchmark', '',
        f'Generated {pd.Timestamp.now(tz="UTC"):%Y-%m-%d %H:%M} UTC by `modelling/benchmark.py`. Test from {TEST_FROM}: '
        f'{te.sum()} slots, {data.common.sum()} with an AAPS IOB curve to 2 h (accuracy is on those); '
        f'{len(data.lows)} lows (< 70 after 30 min above) and {len(data.highs)} highs (> {bm.HIGH} after 30 min below). '
        'mg/dL; bias > 0: too high; skill: MAE below "no change".', '',
        '## Scorecards (all saved runs)', '', cards.to_markdown(), '',
        '## Accuracy', '', md(acc), '',
        '## By situation', '', md(situations), '',
        '## Warnings of lows and highs', '',
        f'A warning ("below 70 within 15 / 30 min", or above {bm.HIGH}) is correct if the low or high comes within '
        f'the window plus {bm.LATE} min (30 / 45 min); an event is caught if a warning came within that time before '
        f'it. Own threshold: the forecast below 70 / above {bm.HIGH}, or the low probability at {bm.LOW_PROBABILITY} '
        'or more. Caught %: share of events with a warning; alarms per week: runs of warnings (less than 15 min apart '
        'count once); alarms correct %: share followed by the event; median minutes of warning: from the first '
        'warning to the event.', '', md(warn), '',
        '## Responses, stability, drift', '', *details,
    ])
    (RESULTS / 'benchmark.md').write_text(report)
    print(f'wrote {RESULTS / "benchmark.md"}')


if __name__ == '__main__':
    main()
