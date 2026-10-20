"""Feature matrix and targets from the 5-minute grid.

A sample is the end of slot i: everything up to and including slot i is
known, nothing later. Targets are the glucose changes g[i+h] - g[i] for
h = 1..horizons (default HORIZONS: 5..60 minutes ahead).

Insulin and carb inputs are the activity of doses given up to slot i: in the
past slots and, already committed, in the coming ones. `oracle=True` uses the
actual future activity instead, including doses given after slot i, as the
2024 notebook did; that is not available when predicting live and only
measures what the leak was worth.
"""

import numpy as np
import pandas as pd

from .actions import carb_kernel, insulin_kernel, remaining

HISTORY = 24          # slots of glucose history (2 h)
HORIZONS = 12         # slots predicted (60 min)
ACTIVITY_LAGS = [0, 3, 6, 9, 12, 18, 23]
HR_LAGS = 6
HR_HIGH = 120
INTERPOLATE_SLOTS = 2
INSULIN_STALE_SLOTS = 72  # no insulin record for 6 h: delivery is unknown
SPORT_HOURS = (1, 3, 6, 24)
LEVEL_DAYS = (1, 3, 7)
LEVEL_FALLBACK = 120.0


def shift(a, k):
    """a[i - k] at position i (NaN outside)."""
    out = np.full(len(a), np.nan)
    if k > 0:
        out[k:] = a[:-k]
    elif k < 0:
        out[:k] = a[-k:]
    else:
        out[:] = a
    return out


def committed(u, kernel, k):
    """Activity in slot i + k of the doses up to slot i."""
    return np.convolve(u, kernel[k:])[:len(u)] if k < len(kernel) else np.zeros(len(u))


def interpolate(a, limit):
    s = pd.Series(a)
    return s.interpolate(limit=limit, limit_area='inside').to_numpy()


def rolling(a, window, fn):
    return getattr(pd.Series(a).rolling(window, min_periods=1), fn)().to_numpy()


LOW = 70


def rescue_carbs(glucose, carbs, grams=15.0, above_slots=6, quiet_slots=6):
    """Carbs assumed eaten but not logged: `grams` in the slot where glucose
    falls below LOW after `above_slots` slots above it, unless carbs were
    logged in the last `quiet_slots` slots. Uses only the past, so a live
    prediction can apply it too."""
    below = glucose < LOW
    above = (~below & ~np.isnan(glucose)).astype(float)
    was_above = shift(rolling(above, above_slots, 'sum'), 1) == above_slots
    recent = rolling(carbs, quiet_slots + 1, 'sum') > 0
    return np.where(below & was_above & ~recent, grams, 0.0)


def no_new_carbs(carbs, horizons=HORIZONS):
    """mask[i, h-1]: no carbs in slots i+1..i+h, so g[i+h] shows what happens
    without eating after the prediction."""
    cs = np.concatenate([[0.0], np.cumsum(carbs)])
    n = len(carbs)
    mask = np.zeros((n, horizons), dtype=bool)
    for h in range(1, horizons + 1):
        end = np.minimum(np.arange(n) + h + 1, n)
        mask[:, h - 1] = cs[end] - cs[np.arange(n) + 1] == 0
    return mask


def future_steps(horizons):
    """Slots ahead with committed-activity inputs: every 5 min for the first
    hour, then every 15 min."""
    return list(range(1, min(horizons, 12) + 1)) + list(range(15, horizons + 1, 3))


def activity_inputs(prefix, on_board, horizons):
    """Names of the activity inputs of insulin ('ia', 'iob') or carbs ('ca',
    'cob'): in the past, committed for the coming slots, on board."""
    return ([f'{prefix}_past_{lag}' for lag in ACTIVITY_LAGS] + [f'{prefix}_fut_{k}' for k in future_steps(horizons)]
            + [on_board])


def build_features(grid, insulin=None, carbs=None, oracle=False, rescue=None, horizons=HORIZONS, sport=False,
                   level=False):
    """Returns (X DataFrame, Y DataFrame of glucose deltas, info DataFrame).

    `rescue` (keyword arguments of rescue_carbs, or {} for the defaults) adds
    assumed rescue carbs to the logged ones. `sport=True` adds recorded
    activity inputs; they did not improve accuracy (FINDINGS.md, Sport).
    `level=True` adds the mean glucose of the last LEVEL_DAYS days
    (g_mean_<d>d; at least half the readings, else LEVEL_FALLBACK)."""
    insulin = insulin or {}
    carbs = carbs or {}
    ik = insulin_kernel(**insulin)
    ck = carb_kernel(**carbs)
    n = len(grid)
    g_raw = grid['glucose'].to_numpy()
    g = interpolate(g_raw, INTERPOLATE_SLOTS)
    # Insulin beyond what the profile basal delivers: the profile basal
    # roughly balances the liver's glucose output.
    u = grid['bolus'].to_numpy() + grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
    c = grid['carbs'].to_numpy()
    assumed = rescue_carbs(g, c, **rescue) if rescue is not None else np.zeros(n)
    c = c + assumed

    cols = {'g_now': g_raw}
    for lag in range(1, HISTORY):
        cols[f'gd_{lag}'] = shift(g, lag) - g_raw

    ia0 = committed(u, ik, 0)
    ca0 = committed(c, ck, 0)
    for lag in ACTIVITY_LAGS:
        cols[f'ia_past_{lag}'] = shift(ia0, lag)
        cols[f'ca_past_{lag}'] = shift(ca0, lag)
    for k in future_steps(horizons):
        cols[f'ia_fut_{k}'] = shift(ia0, -k) if oracle else committed(u, ik, k)
        cols[f'ca_fut_{k}'] = shift(ca0, -k) if oracle else committed(c, ck, k)
    cols['iob'] = np.convolve(u, remaining(ik))[:n]
    cols['cob'] = np.convolve(c, remaining(ck))[:n]
    cols['profile_basal'] = grid['profile_basal'].to_numpy() * 12  # U/h

    hr = grid['hr'].to_numpy()
    hr_known = ~np.isnan(hr)
    hr_fill = interpolate(hr, 3)
    for lag in range(HR_LAGS):
        v = shift(hr_fill, lag)
        cols[f'hr_{lag}'] = np.where(np.isnan(v), 60.0, v)
    recent = rolling(hr_known.astype(float), HR_LAGS, 'sum')
    cols['hr_missing'] = (recent == 0).astype(float)
    cols['hr_mean_2h'] = np.nan_to_num(rolling(np.where(hr_known, hr, np.nan), HISTORY, 'mean'), nan=60.0)
    high = np.where(hr_known, (hr > HR_HIGH).astype(float), 0.0)
    cols['hr_high_24h'] = rolling(high, 288, 'sum') * 5  # minutes
    cols['hr_high_6h'] = rolling(high, 72, 'sum') * 5

    if sport:
        # Recorded activities (see load.py): how much sport recently, how
        # long ago, and how hard.
        active = grid['sport'].to_numpy()
        for hours in SPORT_HOURS:
            cols[f'sport_{hours}h'] = rolling(active, hours * 12, 'sum') * 5  # minutes
        last = np.where(active > 0, np.arange(n), -10 ** 9)
        since = np.arange(n) - np.maximum.accumulate(last)
        cols['sport_since_h'] = np.minimum(since * 5 / 60, 24.0)
        sport_hr = rolling(np.where((active > 0) & hr_known, hr, np.nan), 12, 'mean')
        cols['sport_hr_1h'] = np.nan_to_num(sport_hr, nan=0.0)

    if level:
        for days in LEVEL_DAYS:
            mean = pd.Series(g).rolling(days * 288, min_periods=days * 144).mean().to_numpy()
            cols[f'g_mean_{days}d'] = np.where(np.isnan(mean), LEVEL_FALLBACK, mean)

    hour = grid['local_hour'].to_numpy()
    cols['hour_sin'] = np.sin(2 * np.pi * hour / 24)
    cols['hour_cos'] = np.cos(2 * np.pi * hour / 24)

    X = pd.DataFrame(cols, index=grid.index)
    Y = pd.DataFrame({f'h{h}': shift(g, -h) - g_raw for h in range(1, horizons + 1)}, index=grid.index)

    activity = (grid['bolus'].to_numpy() > 0) | (np.abs(grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()) > 1e-9)
    insulin_known = rolling(activity.astype(float), INSULIN_STALE_SLOTS, 'max') > 0
    valid = (~np.isnan(g_raw) & X.filter(like='gd_').notna().all(axis=1).to_numpy()
             & Y.notna().all(axis=1).to_numpy() & insulin_known)
    info = pd.DataFrame({'valid': valid, 'hr_known': recent > 0, 'assumed_carbs': assumed,
                         'insulin_known': insulin_known}, index=grid.index)
    mask = no_new_carbs(c, horizons)
    for h in range(horizons):
        info[f'no_carbs_h{h + 1}'] = mask[:, h]
    return X, Y, info
