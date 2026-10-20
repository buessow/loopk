"""Reference predictions to beat, as glucose deltas of shape (n, HORIZONS)."""

import numpy as np
import pandas as pd

from .features import HORIZONS
from .grid import SLOT_MIN, to_minutes


def persistence(X, horizons=HORIZONS):
    return np.zeros((len(X), horizons))


def linear_trend(X, points=4, horizons=HORIZONS):
    """Least-squares slope over the last `points` readings, extrapolated."""
    x = np.arange(-(points - 1), 1, dtype=np.float64)
    y = np.column_stack([X[f'gd_{lag}'].to_numpy() for lag in range(points - 1, 0, -1)] + [np.zeros(len(X))])
    xc = x - x.mean()
    slope = (y - y.mean(axis=1, keepdims=True)) @ xc / np.sum(xc ** 2)
    return slope[:, None] * np.arange(1, horizons + 1)[None, :]


def aaps_curves(predictions, index, horizons=HORIZONS):
    """AAPS's predicted curves on the grid: {curve: (len(index), horizons)}
    absolute mg/dL, from the newest suggestion made in each slot."""
    first = to_minutes(index[:1])[0]
    slot = (to_minutes(predictions['date']) - first) // SLOT_MIN
    ok = (slot >= 0) & (slot < len(index))
    p = predictions[ok].assign(slot=slot[ok])
    out = {}
    for curve, rows in p.groupby('curve'):
        if curve not in ('IOB', 'COB', 'UAM', 'ZT'):
            continue
        rows = rows.drop_duplicates('slot', keep='last')
        a = np.full((len(index), horizons), np.nan)
        values = rows['values'].to_numpy()
        for s, v in zip(rows['slot'].to_numpy(), values):
            k = min(horizons, len(v) - 1)
            a[s, :k] = v[1:k + 1]
        out[curve] = a
    cob = np.full(len(index), np.nan)
    first_rows = p.drop_duplicates('slot', keep='last')
    cob[first_rows['slot'].to_numpy()] = first_rows['cob'].to_numpy()
    # The curve AAPS's own display leans on: COB while carbs are on board,
    # else UAM when it computed one, else IOB.
    auto = out.get('IOB', np.full((len(index), horizons), np.nan)).copy()
    if 'UAM' in out:
        has = ~np.isnan(out['UAM'][:, 0])
        auto[has] = out['UAM'][has]
    if 'COB' in out:
        has = ~np.isnan(out['COB'][:, 0]) & (np.nan_to_num(cob) > 0)
        auto[has] = out['COB'][has]
    out['auto'] = auto
    return out


def aaps_decisions(decisions, index, fill=1):
    """AAPS's decision values per grid slot (mg/dL), from the newest loop in
    each slot and carried forward up to `fill` slots: min_guard, min_pred,
    eventual, threshold, lgs (it suspended because min_guard or glucose
    was below threshold) and isf (mg/dL per U, as AAPS used it)."""
    first = to_minutes(index[:1])[0]
    slot = (to_minutes(decisions['date']) - first) // SLOT_MIN
    ok = (slot >= 0) & (slot < len(index))
    d = decisions[ok].assign(slot=slot[ok]).drop_duplicates('slot', keep='last')
    # Reasons are in the user's units; a target above 30 means mg/dL.
    factor = np.where(d['target'].to_numpy() > 30, 1.0, 18.0)
    out = pd.DataFrame(index=np.arange(len(index)),
                       columns=['min_guard', 'min_pred', 'eventual', 'threshold', 'lgs', 'isf'], dtype=float)
    s = d['slot'].to_numpy()
    out.loc[s, 'min_guard'] = d['min_guard'].to_numpy() * factor
    out.loc[s, 'min_pred'] = d['min_pred'].to_numpy() * factor
    out.loc[s, 'eventual'] = d['eventual_bg'].to_numpy()
    out.loc[s, 'isf'] = d['isf'].to_numpy() * factor  # mg/dL per U
    # 0 rather than NaN so filling only reaches slots without a loop.
    out.loc[s, 'threshold'] = d['lgs_threshold'].fillna(0).to_numpy() * factor
    out.loc[s, 'lgs'] = d['lgs_threshold'].notna().to_numpy().astype(float)
    out = out.ffill(limit=fill)
    out['threshold'] = out['threshold'].replace(0, np.nan)
    return out
