"""Checks of the basal and insulin sensitivity AAPS uses, on clean stretches.

All insulin delivered beyond the profile basal (boluses, SMBs, temp basals,
negative while suspended) enters as the units acting in each slot, via the
insulin curve. With AAPS's own ISF (mg/dL per U, as logged in its decisions):

    expected change = - sum over the window of ISF[t] * insulin acting[t]

- Basal: on stretches without carbs and manual boluses, the observed change
  minus the expected one is the drift the profile basal leaves (positive:
  glucose would rise, the basal is too low).
- ISF: after correction boluses without carbs, the observed change against
  the expected one; a slope above 1 means insulin lowers glucose more than
  AAPS assumes.
"""

import numpy as np


def acting(u, kernel):
    """Units acting in each slot from the doses u (U per slot) up to then."""
    return np.convolve(u, kernel)[:len(u)]


def prefix(a):
    """Cumulative sums with a leading 0: sum of a[i:j] is p[j] - p[i]."""
    return np.concatenate([[0.0], np.cumsum(np.nan_to_num(a))])


def none_in(p, starts, a, b):
    """For each start s: nothing in slots s+a .. s+b-1 (p from prefix())."""
    n = len(p) - 1
    lo = np.clip(starts + a, 0, n)
    hi = np.clip(starts + b, 0, n)
    return p[hi] - p[lo] == 0


def through_origin(x, y):
    """Least-squares slope of y = k * x, with a bootstrap 90% interval."""
    k = np.sum(x * y) / np.sum(x * x)
    rng = np.random.default_rng(0)
    boot = []
    for _ in range(300):
        i = rng.integers(0, len(x), len(x))
        boot.append(np.sum(x[i] * y[i]) / np.sum(x[i] * x[i]))
    lo, hi = np.percentile(boot, [5, 95])
    return k, lo, hi


def joint_fit(observed, expected, hours, group, n_boot=300):
    """Least squares of observed = drift[group] * hours + k * expected.

    Returns k with a bootstrap 90% interval, the drift (mg/dL per hour) per
    group, and the mean absolute residual."""
    groups = sorted(set(group))
    G = np.stack([(group == name) * hours for name in groups], axis=1)

    def solve(i):
        A = np.column_stack([G[i], expected[i]])
        coef, *_ = np.linalg.lstsq(A, observed[i], rcond=None)
        return coef

    every = np.arange(len(observed))
    coef = solve(every)
    rng = np.random.default_rng(0)
    boot = [solve(rng.integers(0, len(observed), len(observed)))[-1] for _ in range(n_boot)]
    lo, hi = np.percentile(boot, [5, 95])
    fitted = np.column_stack([G, expected]) @ coef
    return {'k': coef[-1], 'k_lo': lo, 'k_hi': hi, 'drift': dict(zip(groups, coef[:-1])),
            'mae': np.mean(np.abs(observed - fitted))}
