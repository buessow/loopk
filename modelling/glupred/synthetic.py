"""Synthetic samples: a real sample with an extra insulin dose.

A dose of `units` given `ago` slots before now changes the inputs of
build_features exactly as a logged dose would (insulin activity in the
past and committed for the coming slots, IOB), and glucose, in the history
as in the targets, by

    - drop * effect[m]

m slots after the dose: drop is what the whole dose lowers glucose by
(ISF x units, scaled by the caller), effect the cumulative fraction of it
(acted(), on a curve the caller picks). The dose does not change what AAPS
does afterwards, beyond what a reduced effect stands in for.
"""

import numpy as np

from .actions import insulin_kernel, remaining
from .sensitivity import prefix

SENSOR_MIN, SENSOR_MAX = 40, 400  # mg/dL: shifted glucose is clipped here, as a sensor would


def dose_inputs(columns, kernel, prefix, on_board, ago=0):
    """Change per unit (or gram) of a dose given `ago` slots before now, for
    each column: {prefix}_past_lag (activity `lag` slots ago) and
    {prefix}_fut_k by the kernel, `on_board` by what is still to act after
    this slot."""
    def at(j):
        return kernel[j] if 0 <= j < len(kernel) else 0.0

    d = np.zeros(len(columns))
    for j, c in enumerate(columns):
        if c.startswith(f'{prefix}_past_'):
            d[j] = at(ago - int(c.rsplit('_', 1)[1]))
        elif c.startswith(f'{prefix}_fut_'):
            d[j] = at(ago + int(c.rsplit('_', 1)[1]))
        elif c == on_board:
            d[j] = remaining(kernel)[ago] if ago < len(kernel) else 0.0
    return d


def acted(kernel, slots):
    """acted[m] for m = 0..slots: fraction of a dose that has acted m slots
    after the slot it was given in (nothing within its own slot)."""
    k = np.r_[kernel, np.zeros(slots + 1)]
    return np.r_[0.0, np.cumsum(k[1:slots + 1])]


def add_insulin(X, Y, units, ago, drop, ik, effect):
    """Inputs and glucose deltas of the samples with the doses added.

    X: build_features DataFrame (n rows), Y: (n, horizons) deltas; per
    sample units, ago (slots before now) and drop (mg/dL); ik: the insulin
    kernel of the inputs; effect: acted() of the glucose curve, at least
    max(ago) + horizons + 1 long."""
    cols = list(X.columns)
    x = X.to_numpy().copy()
    lags = np.array([int(c[3:]) for c in cols if c.startswith('gd_')])
    gd = [cols.index(f'gd_{lag}') for lag in lags]
    g0 = cols.index('g_now')

    def clip(v):
        return np.clip(v, SENSOR_MIN, SENSOR_MAX)

    def lowered(m):
        return -drop[:, None] * np.where(m >= 0, effect[np.clip(m, 0, len(effect) - 1)], 0.0)

    a = ago[:, None]
    g_now = x[:, g0]
    now = clip(g_now + lowered(a)[:, 0])
    past = clip(g_now[:, None] + x[:, gd] + lowered(a - lags[None, :]))
    h = np.arange(1, Y.shape[1] + 1)[None, :]
    future = clip(g_now[:, None] + Y + lowered(a + h))
    x[:, g0] = now
    x[:, gd] = past - now[:, None]
    for v in np.unique(ago):
        k = ago == v
        x[k] += units[k, None] * dose_inputs(cols, ik, 'ia', 'iob', ago=int(v))[None, :]
    return x, future - now[:, None]


# --- Synthetic copies of real samples (synthetic.py, benchmark.py)

HISTORY_SLOTS = 24             # doses up to 115 min before now
EFFECT_PER_UNIT = 11.7         # mg/dL per U, AAPS's reaction included (corrections.py, night)
EFFECT_CURVE = (35, 120)       # peak, duration (minutes) of that effect
RANDOM_UNITS = (-1, -0.5, 0.5, 1, 2, 3, 4, 5)
BIG_UNITS = (2, 3, 4, 5)
MEAL_BOLUS, MEAL_CARBS = 2.0, 20.0


def effect_curve(horizons):
    return acted(insulin_kernel(peak=EFFECT_CURVE[0], duration=EFFECT_CURVE[1]), HISTORY_SLOTS + horizons + 1)


def moments(grid, X):
    """Per slot: `peak` (glucose stopped rising after a rise of 15 mg/dL or
    more in the hour before, or falls 5+ per 15 min from above 120),
    `trend` (change over the last 15 min), and after a meal bolus (MEAL_BOLUS
    or more with MEAL_CARBS or more within 15 min, the only manual bolus in
    the last 2 h) `after_meal`, `meal_ago` (slots) and `meal_units`."""
    n = len(grid)
    i = np.arange(n)
    manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
    p_manual, p_carbs = prefix(manual), prefix(grid['carbs'].to_numpy())

    def win(p, a, b):
        return p[np.clip(i + b, 0, n)] - p[np.clip(i + a, 0, n)]

    g_now = X['g_now'].to_numpy()
    trend = -X['gd_3'].to_numpy()
    rise = X['gd_3'].to_numpy() - X['gd_12'].to_numpy()
    peak = ((rise >= 15) & (np.abs(trend) <= 3)) | ((trend <= -5) & (g_now >= 120))
    meal = (manual >= MEAL_BOLUS) & (win(p_carbs, -3, 4) >= MEAL_CARBS)
    last = np.maximum.accumulate(np.where(meal, i, -10 ** 9))
    ago = i - last
    after = ago < HISTORY_SLOTS
    units = np.where(after, manual[np.clip(last, 0, n - 1)], 0.0)
    after &= win(p_manual, -HISTORY_SLOTS + 1, 1) - units < 0.1
    return {'peak': peak, 'trend': trend, 'after_meal': after, 'meal_ago': ago, 'meal_units': units}


def copies(kind, X, Y, sel, m, seed, horizons):
    """Synthetic copies of the samples in `sel` (bool per slot) of one kind:
    'random' (RANDOM_UNITS at a random time in the last 2 h), 'peak'
    (BIG_UNITS in the last 30 min at m['peak']) or 'meal' (the meal bolus
    taken away). Returns (inputs, deltas, slot of each copy)."""
    rng = np.random.default_rng(seed)
    if kind == 'random':
        j = np.where(sel)[0]
        units = np.array(RANDOM_UNITS)[rng.integers(0, len(RANDOM_UNITS), len(j))]
        ago = rng.integers(0, HISTORY_SLOTS, len(j))
    elif kind == 'peak':
        j = np.where(sel & m['peak'])[0]
        units = np.array(BIG_UNITS, dtype=float)[rng.integers(0, len(BIG_UNITS), len(j))]
        ago = rng.integers(0, 7, len(j))
    elif kind == 'meal':
        j = np.where(sel & m['after_meal'])[0]
        ago = m['meal_ago'][j]
        units = -m['meal_units'][j]
    else:
        raise ValueError(kind)
    xs, ys = add_insulin(X.iloc[j], Y[j], units, ago, EFFECT_PER_UNIT * units, insulin_kernel(), effect_curve(horizons))
    return xs, ys, j
