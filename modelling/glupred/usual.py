"""The usual actions after slot i: carbs eaten and insulin delivered.

The glucose forecast assumes that AAPS and the person behave as usual. These
targets let a model say what that is: how much is usually eaten in the next
30 / 60 / 120 minutes, and how much insulin AAPS (or a bolus) will deliver
beyond the profile basal.
"""

import numpy as np
import pandas as pd

ATE_GRAMS = 5.0  # eating at all: carbs of at least this much in the window


def ahead(a, slots):
    """Sum of a[i+1..i+slots] at position i (NaN where the window runs past the end)."""
    cs = np.concatenate([[0.0], np.cumsum(a)])
    n = len(a)
    i = np.arange(n)
    out = np.full(n, np.nan)
    ok = i + slots < n
    out[ok] = cs[i[ok] + slots + 1] - cs[i[ok] + 1]
    return out


def behind(a, slots):
    """Sum of a[i-slots+1..i] at position i (the window clipped at the start)."""
    cs = np.concatenate([[0.0], np.cumsum(a)])
    i = np.arange(len(a))
    return cs[i + 1] - cs[np.maximum(i + 1 - slots, 0)]


def usual_targets(grid, minutes=(30, 60, 120), slot_minutes=5):
    """carbs_<m> (g), ate_<m> (bool), insulin_<m> (U beyond the profile basal)
    for the m minutes after each slot. With an `smb` column (U per slot), also
    auto_<m>: what AAPS decides (SMBs and temp basals beyond the profile), and
    manual_<m>: the other boluses."""
    carbs = np.nan_to_num(grid['carbs'].to_numpy())
    bolus = grid['bolus'].to_numpy()
    temp = grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
    cols = {}
    for m in minutes:
        k = m // slot_minutes
        cols[f'carbs_{m}'] = ahead(carbs, k)
        cols[f'ate_{m}'] = cols[f'carbs_{m}'] >= ATE_GRAMS
        cols[f'insulin_{m}'] = ahead(bolus + temp, k)
        if 'smb' in grid:
            smb = grid['smb'].to_numpy()
            cols[f'auto_{m}'] = ahead(smb + temp, k)
            cols[f'manual_{m}'] = ahead(bolus - smb, k)
    return pd.DataFrame(cols, index=grid.index)
