"""Glucose simulated from insulin and carbs with AAPS's values (oref physics).

Each 5-minute slot changes glucose by

    - ISF[t] * insulin acting[t] + ISF[t] / CR[t] * carbs absorbed[t] + drift[t]

where insulin acting covers all insulin beyond the profile basal (the
profile basal is assumed to balance the liver's output, drift 0), ISF is in
mg/dL per U and CR in g per U. Starting from a real reading, `replay` adds
these effects up over the coming slots; with the actions that actually
followed, it shows how well the physics alone tracks the sensor.
"""

import numpy as np

from .sensitivity import prefix


def effects(isf, cr, insulin_acting, carbs_absorbed, drift=0.0):
    """mg/dL change caused in each slot."""
    return -isf * insulin_acting + isf / cr * carbs_absorbed + drift


def replay(g, change, starts, horizons):
    """Simulated glucose at starts + h for each h in `horizons` (slots):
    the reading at the start plus the changes of the slots after it."""
    p = prefix(change)
    starts = np.asarray(starts)
    return np.column_stack([g[starts] + p[starts + h + 1] - p[starts + 1] for h in horizons])
