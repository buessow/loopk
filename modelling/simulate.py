"""How realistic is a glucose simulator with AAPS's ISF and carb ratio?

    uv run python simulate.py

Replays the test period: from each reading, glucose is simulated 30 min to
4 h ahead from the insulin and carbs that actually followed
(glupred/simulate.py), and compared with the sensor. Only if the simulated
traces track the real ones can the simulator generate "what if" training
data. Variants:
- AAPS's logged ISF and CR,
- with the "Default" carb ratio where AAPS logged 30 g/U or more (a profile
  that leaves meals to SMBs rather than a physiological ratio),
- plus the 15 g assumed when glucose falls below 70 with nothing logged,
- plus a drift per hour of the day (the basal gap: how fast glucose rises
  with only the profile basal), fitted on the validation half-year before
  the test period with AAPS's ISF and CR fixed.

The simulator knows the future insulin and carbs, so it is not a forecast:
its errors measure how far the physics is from the body.
Writes results/simulate.md (not committed: derived from health data).
"""

import numpy as np
import pandas as pd

from glupred.actions import carb_kernel, insulin_kernel
from glupred.baselines import aaps_decisions
from glupred.features import interpolate, rescue_carbs
from glupred.load import load
from glupred.sensitivity import acting, prefix
from glupred.simulate import effects, replay
from train import RESULTS, TEST_FROM, VALIDATION_FROM, grid_cached

HORIZONS = {'30 min': 6, '1 h': 12, '2 h': 24, '4 h': 48}
MEAL_CR = 30  # g/U and above: not a physiological ratio


def physiological(cr):
    """The carb ratio, with logged values of MEAL_CR and above replaced by the
    last one below it."""
    return pd.Series(np.where(cr >= MEAL_CR, np.nan, cr)).ffill().to_numpy()


def hourly_drift(g, change, hour, fit):
    """Mean of (observed - simulated) change per slot, by local hour, over the
    slots in `fit` (mg/dL per slot), as a value for every slot."""
    resid = np.r_[np.diff(g), np.nan] - np.r_[change[1:], np.nan]
    h = np.floor(hour).astype(int)
    ok = fit & ~np.isnan(resid)
    by_hour = pd.Series(resid[ok]).groupby(h[ok]).mean().reindex(range(24)).fillna(0)
    return by_hour.to_numpy()[h], by_hour * 12


def main():
    grid = grid_cached(False)
    n = len(grid)
    g = interpolate(grid['glucose'].to_numpy(), 2)
    dec = aaps_decisions(load('aaps_decisions'), grid.index, fill=12)
    isf, cr = dec['isf'].to_numpy(), dec['cr'].to_numpy()
    net = grid['bolus'].to_numpy() + grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
    ins = acting(net, insulin_kernel())
    logged = np.nan_to_num(grid['carbs'].to_numpy())
    assumed = rescue_carbs(g, logged)
    ck = carb_kernel()
    carbs = acting(logged, ck)
    carbs_assumed = acting(logged + assumed, ck)
    manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
    sport = grid['sport'].to_numpy()
    cr_phys = physiological(cr)

    variants = {
        'AAPS ISF and CR': effects(isf, cr, ins, carbs),
        'AAPS ISF, Default CR': effects(isf, cr_phys, ins, carbs),
        '+ assumed rescue carbs': effects(isf, cr_phys, ins, carbs_assumed),
        'insulin only (no carbs)': effects(isf, cr_phys, ins, 0 * carbs),
    }
    fit = (grid.index >= pd.Timestamp(VALIDATION_FROM, tz='UTC')) & (grid.index < pd.Timestamp(TEST_FROM, tz='UTC'))
    base = np.nan_to_num(variants['+ assumed rescue carbs'])
    drift, drift_by_hour = hourly_drift(g, base, grid['local_hour'].to_numpy(), fit)
    variants['+ hourly drift'] = variants['+ assumed rescue carbs'] + drift
    H = max(HORIZONS.values())
    test = np.where(grid.index >= pd.Timestamp(TEST_FROM, tz='UTC'))[0]
    s = test[(test >= 48) & (test < n - H - 1)]
    p_gap = prefix(np.isnan(g).astype(float))
    p_known = prefix(np.isnan(isf) | np.isnan(cr_phys))
    s = s[(p_gap[s + H + 1] - p_gap[s] == 0) & (p_known[s + H + 1] - p_known[s] == 0)]
    actual = np.column_stack([g[s + h] for h in HORIZONS.values()])

    # Situations over the first 2 h.
    p_carbs, p_manual, p_sport = prefix(logged), prefix(manual), prefix(sport)
    win = lambda p, a, b: p[np.clip(s + b, 0, n)] - p[np.clip(s + a, 0, n)]
    meal = win(p_carbs, 0, 13) >= 10
    correction = (win(p_manual, 0, 7) >= 0.5) & (win(p_carbs, -48, 25) == 0)
    fasting = (win(p_carbs, -48, 25) == 0) & (win(p_manual, -72, 25) == 0)
    situations = {
        'all': np.ones(len(s), dtype=bool),
        'meal (10+ g within 1 h)': meal,
        'correction, no carbs': correction,
        'fasting (no carbs 4 h, no manual bolus 6 h)': fasting,
        'sport within 2 h': win(p_sport, -12, 25) > 0,
        'start < 90': g[s] < 90,
        'start > 180': g[s] > 180,
    }

    rows = []
    persistence = np.repeat(g[s][:, None], len(HORIZONS), axis=1)
    sims = {name: replay(g, change, s, list(HORIZONS.values())) for name, change in variants.items()}
    for sit, k in situations.items():
        for name, pred in [('persistence', persistence), *sims.items()]:
            err = pred[k] - actual[k]
            row = {'situation': sit, 'n': int(k.sum()), 'method': name}
            for j, label in enumerate(HORIZONS):
                row[f'MAE {label}'] = np.mean(np.abs(err[:, j]))
            for j, label in enumerate(HORIZONS):
                if label in ('1 h', '2 h'):
                    row[f'bias {label}'] = np.mean(err[:, j])
            rows.append(row)
    table = pd.DataFrame(rows).round(1)

    # Diagnostic: how much of the insulin and carb effects the 2 h changes
    # support (least squares, with an intercept). Confounded like the ISF
    # check in sensitivity.py; shown for scale only.
    h = HORIZONS['2 h']
    pi = prefix(-isf * ins)
    pc = prefix(isf / cr_phys * carbs_assumed)
    xi = pi[s + h + 1] - pi[s + 1]
    xc = pc[s + h + 1] - pc[s + 1]
    y = g[s + h] - g[s]
    A = np.column_stack([np.ones(len(s)), xi, xc])
    coef = np.linalg.lstsq(A, y, rcond=None)[0]

    report = '\n'.join([
        '# Simulated glucose with AAPS\'s values vs the sensor', '',
        f'Test period from {TEST_FROM}; starts every 5 minutes with 4 h of sensor data after them. '
        'The simulator is given the insulin and carbs that actually followed. MAE and bias in mg/dL '
        '(bias > 0: simulated too high).', '',
        table.to_markdown(index=False), '',
        'Hourly drift (mg/dL per hour) fitted on ' + VALIDATION_FROM + ' – ' + TEST_FROM + ': '
        + ', '.join(f'{h}: {v:+.0f}' for h, v in drift_by_hour.items()), '',
        f'Scale the 2 h changes support (least squares with intercept): insulin effect × {coef[1]:.2f}, '
        f'carb effect × {coef[2]:.2f}, intercept {coef[0]:.1f} mg/dL per 2 h. Confounded (AAPS and you react '
        'to glucose); for scale only.', '',
        'For comparison, the MLP forecast (not knowing the future insulin and carbs): MAE 17.2 / 26.6 / 31.0 / '
        '32.7 at 30 min / 1 h / 2 h / 4 h (FINDINGS.md).', '',
    ])
    (RESULTS / 'simulate.md').write_text(report)
    print(report)


if __name__ == '__main__':
    main()
