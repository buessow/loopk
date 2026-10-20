"""Insulin action curve fitted to the glucose response.

    uv run python curve.py

Every 5-minute glucose change is regressed on the insulin delivered beyond
the profile basal in the 6 hours before (15-minute bins), the glucose
changes of the last 30 minutes (AAPS reacts to them) and the local hour
(basal gap), on slots since 2021 without carbs in the 4 h before, sport in
the 6 h before and (in most rows) a low in the 3 h before. The lag
coefficients, run through the 30-minute terms, give the glucose response to
1 U over time without assuming a shape; AAPS's exponential curve (peak,
duration) and an ISF are then fitted to it.

Manual boluses and AAPS's insulin (SMBs, temp basals) are also estimated
separately. AAPS's insulin shows a rise after 30 minutes: it is given when
glucose starts rising, so its response is confounded. Manual boluses are
less so, but the total per unit is still too low (you also correct when
glucose rises); trust the timing more than the size.

Writes results/curve.md (not committed: derived from health data).
"""

import numpy as np
import pandas as pd

from glupred.actions import insulin_kernel
from glupred.features import interpolate
from glupred.sensitivity import prefix
from train import RESULTS, grid_cached

BINS, W, AR = 24, 3, 6   # 24 bins of 15 min (6 h); 6 terms of the last 30 min
SHOWN = {'30 min': 5, '1 h': 11, '2 h': 23, '3 h': 35, '4 h': 47, '6 h': 71}


def lagged(p, t):
    """Units delivered in each 15-minute bin before t (bin 0: slots t-2..t)."""
    return np.column_stack([p[t - W * j + 1] - p[t - W * j - W + 1] for j in range(BINS)])


def response(w, a):
    """Cumulative glucose response (mg/dL) to 1 U, per slot over 6 h, from
    the lag coefficients w (per bin) and the autoregressive terms a."""
    d = np.zeros(BINS * W)
    for s in range(len(d)):
        d[s] = w[s // W] + sum(a[i] * d[s - 1 - i] for i in range(len(a)) if s - 1 - i >= 0)
    return np.cumsum(d)


def fit_curve(resp):
    """Exponential curve (peak, duration in minutes) and ISF closest to resp."""
    best = None
    for peak in range(20, 125, 5):
        for dia in range(120, 481, 30):
            if 2 * peak >= dia:
                continue
            c = np.cumsum(insulin_kernel(peak=peak, duration=dia))
            c = np.r_[c, np.ones(max(0, len(resp) - len(c)))][:len(resp)]
            isf = -np.sum(c * resp) / np.sum(c * c)
            err = np.sqrt(np.mean((resp + isf * c) ** 2))
            if best is None or err < best[0]:
                best = (err, peak, dia, isf)
    return best


def row(label, kind, n, resp):
    err, peak, dia, isf = fit_curve(resp)
    return {'slots': label, 'insulin': kind, 'n': n,
            'response ' + ' / '.join(SHOWN): ' / '.join(f'{resp[i]:.0f}' for i in SHOWN.values()),
            'half the effect after (min)': int(np.argmax(resp <= resp.min() / 2) * 5 + 5),
            'fitted peak (min)': peak, 'fitted duration (h)': dia / 60, 'fitted ISF': round(isf), 'fit error': round(err, 1)}


def main():
    grid = grid_cached(False)
    n = len(grid)
    g = interpolate(grid['glucose'].to_numpy(), 2)
    net = grid['bolus'].to_numpy() + grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
    manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
    hour = np.floor(grid['local_hour'].to_numpy()).astype(int) % 24
    year = grid.index.year.to_numpy()
    dg = np.r_[np.nan, np.diff(g)]
    pc, ps, pl = prefix(grid['carbs'].to_numpy()), prefix(grid['sport'].to_numpy()), prefix((g < 70).astype(float))

    t = np.arange(BINS * W + AR + 1, n)
    X_all = lagged(prefix(net), t)
    X_manual = lagged(prefix(manual), t)
    X_auto = lagged(prefix(net - manual), t)
    X_ar = np.column_stack([dg[t - i] for i in range(1, AR + 1)])
    hours = np.eye(24)[hour[t]]
    y = dg[t]
    clean = (~np.isnan(y) & ~np.isnan(X_ar).any(axis=1) & (pc[t + 1] - pc[t - 48] == 0)
             & (ps[t + 1] - ps[t - 72] == 0) & (year[t] >= 2021))
    no_low = (pl[t + 1] - pl[t - 36]) == 0
    night = (hour[t] >= 23) | (hour[t] < 7)

    def fit(sel, inputs, ar=True):
        A = np.column_stack(inputs + ([X_ar] if ar else []) + [hours])[sel]
        coef = np.linalg.lstsq(A, y[sel], rcond=None)[0]
        k = BINS * len(inputs)
        a = coef[k:k + AR] if ar else np.zeros(AR)
        return [response(coef[BINS * i:BINS * (i + 1)], a) for i in range(len(inputs))]

    rows = []
    for label, sel, ar in (('clean', clean, True), ('clean, without the 30-minute terms', clean, False),
                           ('clean, no low in the 3 h before', clean & no_low, True),
                           ('night 23–7', clean & no_low & night, True), ('day 7–23', clean & no_low & ~night, True),
                           ('2021–2023', clean & no_low & (year[t] <= 2023), True),
                           ('2024–2026', clean & no_low & (year[t] >= 2024), True)):
        rows.append(row(label, 'all', int(sel.sum()), fit(sel, [X_all], ar)[0]))
        print(rows[-1])
    split = []
    for label, sel in (('no low in the 3 h before', clean & no_low), ('night 23–7', clean & no_low & night),
                       ('day 7–23', clean & no_low & ~night)):
        r_manual, r_auto = fit(sel, [X_manual, X_auto])
        split.append(row(label, 'manual bolus', int(sel.sum()), r_manual))
        split.append(row(label, 'AAPS (SMB, temp basal)', int(sel.sum()), r_auto))
        print(split[-2], split[-1])
    c = np.cumsum(insulin_kernel())
    report = '\n'.join([
        '# Insulin action curve fitted to the glucose response', '',
        'Glucose response to 1 U beyond the profile basal (mg/dL), and the exponential curve fitted to it. '
        'Slots since 2021 without carbs in the 4 h before and sport in the 6 h before.', '',
        '## All insulin', '', pd.DataFrame(rows).to_markdown(index=False), '',
        '## Manual boluses and AAPS insulin separately', '', pd.DataFrame(split).to_markdown(index=False), '',
        'AAPS\'s curve (peak 55 min, 6 h) at ISF 32: ' + ' / '.join(f'{-32 * c[i]:.0f}' for i in SHOWN.values()), '',
        'AAPS\'s insulin rises first: it is given as glucose starts rising (confounded). The size per unit is '
        'too low for both (you correct when glucose rises, too); the timing of manual boluses is the most '
        'reliable result.', '',
    ])
    (RESULTS / 'curve.md').write_text(report)
    print(report)


if __name__ == '__main__':
    main()
