"""Insulin plans: what is delivered from the next slot on.

A plan is net insulin per slot beyond the profile basal (as in features.py),
for slots i+1..i+horizons. AAPS's curves assume two plans:
- profile: profile basal, no more boluses (the IOB, COB and UAM curves),
- zero: no delivery for the next 4 h (the ZT curve).
"""

import numpy as np

from .features import committed, shift


def planned_activity(u, kernel, horizons):
    """act[i, k-1]: activity in slot i+k of the net insulin actually delivered
    in slots i+1..i+k (what was planned, in hindsight)."""
    ia0 = committed(u, kernel, 0)
    return np.column_stack([shift(ia0, -k) - committed(u, kernel, k) for k in range(1, horizons + 1)])


def constant_plan(rate, kernel, horizons):
    """act[i, k-1] for a constant net rate (U per slot, one per sample) from
    slot i+1 on."""
    cum = np.cumsum(kernel)[:horizons]
    return rate[:, None] * cum[None, :]


def followed(ok, slots):
    """ok[i]: the plan held in slot i. Returns (n, slots) where [i, h-1] says
    it held in all of slots i+1..i+h."""
    bad = np.concatenate([[0], np.cumsum(~ok)])
    i = np.arange(len(ok))
    return np.column_stack([bad[np.minimum(i + 1 + h, len(ok))] - bad[i + 1] == 0 for h in range(1, slots + 1)])
