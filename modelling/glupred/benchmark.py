"""The standard scorecard for glucose forecasts (benchmark.py).

A candidate is anything with `columns` (input names, a subset of the
benchmark's feature frame) and `predict(X)` returning {'mean': glucose
(n, horizons), optionally 'q0.1', 'q0.9' and 'p_low_30'}. Everything is
scored on the test period:

- accuracy: MAE, RMSE, P90, bias and Clarke A at 15/30/60/120 min on the
  slots where AAPS made an IOB curve, against "no change" and AAPS's IOB
  and display curves; skill = 1 - MAE / MAE of "no change";
- by situation: actual glucose range, after a meal bolus or a correction,
  night, after sport, high heart rate;
- warnings of lows (< 70) within 15 and 30 min and of highs (> 250)
  within 30 min, per episode: a warning is correct, and the event caught,
  if the event comes within the window plus LATE minutes (a 30-min warning
  counts for a low within 45 min); at the model's own threshold and at an
  alarm budget (ALARMS_PER_WEEK), from the forecast and the low probability;
- response: the forecast change for insulin (glupred/synthetic.py; history
  shifted for a dose in the past), carbs and 30 min of exercise, with the
  share in the wrong direction;
- stability (how much the forecast for the same moment moves in 5 min),
  80% band coverage, and bias per half-year of the test period.
"""

import numpy as np
import pandas as pd

from .actions import carb_kernel, insulin_kernel
from .features import interpolate
from .metrics import clarke_zone
from .scenarios import crossings, warning_episodes
from .synthetic import EFFECT_PER_UNIT, add_insulin, dose_inputs, effect_curve

MINUTES = (15, 30, 60, 120)
WARN_SLOTS = 6                 # longest warning window (30 min)
LATE = 15                      # minutes a low may come after the warning's window
HIGH = 250
ALARMS_PER_WEEK = 7
LOW_PROBABILITY = 0.4          # the server's warning threshold (export.py)
PROBE_SAMPLES = 20000
EXERCISE_HR = 140


def _slot(minutes):
    return minutes // 5 - 1


class Data:
    """Test-period arrays the scorecard needs. X: features of all slots
    (build_features with level and sport), Y: deltas, info, the grid, the
    test mask, AAPS's curves ({name: (n, H)}) and moments() of synthetic.py."""

    def __init__(self, grid, X, Y, info, test, aaps, moments):
        self.grid, self.X, self.info, self.m = grid, X, info, moments
        self.H = Y.shape[1]
        self.Xn = X.to_numpy()
        self.cols = list(X.columns)
        self.g = X['g_now'].to_numpy()
        self.Y = Y.to_numpy()
        self.actual = self.Y + self.g[:, None]
        self.mask = info[[f'no_carbs_h{h + 1}' for h in range(self.H)]].to_numpy()
        self.test = test
        self.aaps = aaps
        self.common = test & ~np.isnan(aaps['IOB'][:, _slot(120)])
        n = len(grid)
        i = np.arange(n)
        manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
        carbs = np.nan_to_num(grid['carbs'].to_numpy())
        p = lambda a: np.concatenate([[0.0], np.cumsum(np.nan_to_num(a))])
        pm, pc, ps = p(manual), p(carbs), p(grid['sport'].to_numpy())
        win = lambda q, a, b: q[np.clip(i + b, 0, n)] - q[np.clip(i + a, 0, n)]
        hour = grid['local_hour'].to_numpy()
        hr = grid['hr'].to_numpy()
        self.situations = {
            'meal bolus 0–2 h ago': moments['after_meal'],
            'correction 0–2 h ago, no carbs 4 h': (win(pm, -23, 1) >= 0.5) & (win(pc, -47, 1) == 0),
            'night 0–6': hour < 6,
            'sport 0–2 h ago': win(ps, -23, 1) > 0,
            'heart rate > 120 now': np.nan_to_num(hr) > 120,
            'peak or falling': moments['peak'],
        }
        self.weeks = test.sum() / 288 / 7
        glucose = interpolate(grid['glucose'].to_numpy(), 2)
        self.lows = self._events(crossings(glucose, 70))
        self.highs = self._events(crossings(glucose, HIGH, rising=True))

    def _events(self, slots):
        return slots[(slots > WARN_SLOTS) & self.test[np.maximum(slots - 1, 0)]]

    def inputs(self, candidate, Xn=None):
        idx = [self.cols.index(c) for c in candidate.columns]
        return (self.Xn if Xn is None else Xn)[:, idx]


def accuracy(data, preds):
    """preds: {name: (n_common, H') glucose} on data.common slots."""
    actual = data.actual[data.common]
    mask = data.mask[data.common]
    persistence_mae = {}
    rows = []
    for scope in ('all', 'nothing eaten before the horizon'):
        for name, p in preds.items():
            row = {'samples': scope, 'model': name}
            for m in MINUTES:
                h = _slot(m)
                if h >= p.shape[1]:
                    continue
                ok = ~np.isnan(p[:, h]) & (mask[:, h] if scope != 'all' else True)
                e = p[ok, h] - actual[ok, h]
                mae = np.mean(np.abs(e))
                row[f'MAE {m}m'] = mae
                if m == 30:
                    row['n'] = int(ok.sum())
                row[f'RMSE {m}m'] = np.sqrt(np.mean(e ** 2))
                row[f'P90 {m}m'] = np.percentile(np.abs(e), 90)
                row[f'bias {m}m'] = np.mean(e)
                row[f'Clarke A {m}m %'] = 100 * np.mean(clarke_zone(actual[ok, h], p[ok, h]) == 'A')
                if name == 'no change':
                    persistence_mae[(scope, m)] = mae
                row[f'skill {m}m %'] = 100 * (1 - mae / persistence_mae[(scope, m)]) if (scope, m) in persistence_mae else np.nan
            rows.append(row)
    return pd.DataFrame(rows)


def by_situation(data, preds):
    """MAE and bias at 30 and 60 min by actual range and situation."""
    actual = data.actual[data.common]
    rows = []
    for m in (30, 60):
        h = _slot(m)
        groups = {'actual < 70': actual[:, h] < 70, 'actual 70–180': (actual[:, h] >= 70) & (actual[:, h] <= 180),
                  'actual > 180': actual[:, h] > 180}
        groups.update({k: v[data.common] for k, v in data.situations.items()})
        for group, sel in groups.items():
            for name, p in preds.items():
                if h >= p.shape[1]:
                    continue
                ok = sel & ~np.isnan(p[:, h])
                e = p[ok, h] - actual[ok, h]
                rows.append({'minutes': m, 'situation': group, 'model': name, 'n': int(ok.sum()),
                             'MAE': np.mean(np.abs(e)) if ok.any() else np.nan,
                             'bias': np.mean(e) if ok.any() else np.nan})
    return pd.DataFrame(rows)


def _budget_threshold(score, data, events, slots):
    """Score threshold that gives about ALARMS_PER_WEEK alarms."""
    lo, hi = np.nanmin(score), np.nanmax(score)
    for _ in range(30):
        mid = (lo + hi) / 2
        r = warning_episodes(np.nan_to_num(score, nan=-np.inf) >= mid, events, data.weeks, slots)
        if r['alarms per week'] > ALARMS_PER_WEEK:
            lo = mid
        else:
            hi = mid
    return hi


def warnings(data, scores):
    """scores: dicts with model, warning ('forecast' or 'low probability'),
    kind ('low' or 'high'), minutes (the warning window), own (threshold)
    and score per grid slot (higher: the event more likely). Warnings are
    only given while glucose is not yet beyond the level. A warning is
    correct, and an event caught, if the event comes within `minutes` +
    LATE after the warning."""
    rows = []
    for w in scores:
        events = data.lows if w['kind'] == 'low' else data.highs
        slots = (w['minutes'] + LATE) // 5
        # Warn only before the event: at or above 70 for lows, at or below HIGH for highs.
        before = data.g >= 70 if w['kind'] == 'low' else data.g <= HIGH
        score = np.where(data.test & before, w['score'], np.nan)
        for label, thr in (('own threshold', w['own']), (f'{ALARMS_PER_WEEK} alarms / week', None)):
            t = _budget_threshold(score, data, events, slots) if thr is None else thr
            r = warning_episodes(np.nan_to_num(score, nan=-np.inf) >= t, events, data.weeks, slots)
            rows.append({'warning': f'{"< 70" if w["kind"] == "low" else f"> {HIGH}"} within {w["minutes"]} min',
                         'model': w['model'], 'warning from': w['warning'], 'threshold': label,
                         'caught %': r['announced %'], 'alarms per week': r['alarms per week'],
                         'alarms correct %': r['alarms followed by the event %'],
                         'median minutes of warning': r['median minutes ahead']})
    return pd.DataFrame(rows)


def _sample(sel, seed=0):
    j = np.where(sel)[0]
    return np.sort(j[np.random.default_rng(seed).choice(len(j), min(PROBE_SAMPLES, len(j)), replace=False)])


def responses(data, candidate):
    """Forecast change for insulin, carbs and exercise (only for the inputs
    the candidate has)."""
    cols = set(candidate.columns)
    rows = []

    def change(label, j, Xd, g_new, expected=None, sign=None):
        """sign: +1 if the change should lower the forecast, -1 if raise."""
        base = candidate.predict(data.inputs(candidate)[j], data.g[j])['mean']
        new = candidate.predict(data.inputs(candidate, Xd), g_new)['mean']
        d = new - base
        row = {'change': label, 'n': len(j)}
        for m in (30, 60, 120):
            h = _slot(m)
            if h < d.shape[1]:
                row[f'{m}m'] = np.mean(d[:, h])
                if expected is not None:
                    row[f'expected {m}m'] = np.mean(expected[:, h])
        h = min(_slot(60), d.shape[1] - 1)
        if sign is not None:
            row['wrong direction %'] = 100 * np.mean(d[:, h] * sign > 0)
        rows.append(row)

    if 'ia_past_0' in cols:
        ik, effect = insulin_kernel(), effect_curve(data.H)
        test = data.test
        for label, sel, units, ago in (
                ('+1 U now', test, 1.0, 0), ('+2 U now', test, 2.0, 0), ('+5 U now', test, 5.0, 0),
                ('+2 U now, glucose < 100', test & (data.g < 100), 2.0, 0),
                ('+2 U now, rising 5+ per 15 min', test & (data.m['trend'] >= 5), 2.0, 0),
                ('+2 U 1 h ago', test, 2.0, 12)):
            j = _sample(sel)
            u = np.full(len(j), units)
            a = np.full(len(j), ago)
            xd, yd = add_insulin(data.X.iloc[j], data.Y[j], u, a, EFFECT_PER_UNIT * u, ik, effect)
            change(label, j, xd, xd[:, 0], expected=(xd[:, :1] + yd) - data.actual[j], sign=1)
        j = _sample(test & data.m['after_meal'])
        u = -data.m['meal_units'][j]
        xd, yd = add_insulin(data.X.iloc[j], data.Y[j], u, data.m['meal_ago'][j], EFFECT_PER_UNIT * u, ik, effect)
        change('meal bolus removed', j, xd, xd[:, 0], expected=(xd[:, :1] + yd) - data.actual[j], sign=-1)
    if 'ca_past_0' in cols:
        d = dose_inputs(data.cols, carb_kernel(), 'ca', 'cob')
        for grams in (20, 50):
            j = _sample(data.test)
            change(f'+{grams} g carbs now', j, data.Xn[j] + grams * d[None, :], data.g[j], sign=-1)
    if 'hr_0' in cols:
        j = _sample(data.test & (np.nan_to_num(data.grid['hr'].to_numpy()) < 100) & (data.Xn[:, data.cols.index('hr_missing')] == 0))
        xd = data.Xn[j].copy()
        c = data.cols.index
        for lag in range(6):
            xd[:, c(f'hr_{lag}')] = EXERCISE_HR
        xd[:, c('hr_mean_2h')] = (xd[:, c('hr_mean_2h')] * 18 + EXERCISE_HR * 6) / 24
        xd[:, c('hr_high_6h')] += 30
        xd[:, c('hr_high_24h')] += 30
        change(f'30 min at heart rate {EXERCISE_HR} just now', j, xd, data.g[j])
    return pd.DataFrame(rows)


def stability(data, name, pred):
    """How much the forecast for the same moment changes 5 minutes later, and
    80% band coverage. pred: candidate output on all test slots."""
    idx = np.where(data.test)[0]
    pos = {s: k for k, s in enumerate(idx)}
    prev = np.array([pos.get(s - 1, -1) for s in idx])
    ok = prev >= 0
    p = pred['mean']
    row = {'model': name}
    for m in (30, 60):
        h = _slot(m)
        if h < p.shape[1]:
            # p[i, h - 1] and p[i - 1, h] forecast the same moment.
            row[f'revision of the {m}m forecast in 5 min'] = np.nanmean(np.abs(p[ok, h - 1] - p[prev[ok], h]))
    for m in (15, 30):
        h = _slot(m)
        if 'q0.1' in pred and h < p.shape[1]:
            a = data.actual[idx, h]
            row[f'80% band holds {m}m %'] = 100 * np.mean((a >= pred['q0.1'][:, h]) & (a <= pred['q0.9'][:, h]))
    return row


def drift(data, name, pred):
    """Bias per half-year of the test period (30 and 60 min)."""
    idx = data.X.index[data.test]
    half = [f'{t.year}-{"01" if t.month <= 6 else "07"}' for t in idx]
    rows = []
    actual = data.actual[data.test]
    for part in sorted(set(half)):
        k = np.array(half) == part
        row = {'model': name, 'half-year': part, 'n': int(k.sum())}
        for m in (30, 60):
            h = _slot(m)
            if h < pred['mean'].shape[1]:
                row[f'bias {m}m'] = np.nanmean(pred['mean'][k, h] - actual[k, h])
        rows.append(row)
    return pd.DataFrame(rows)
