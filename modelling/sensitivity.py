"""Is AAPS's basal and insulin sensitivity right? Checked on clean stretches.

    uv run python sensitivity.py

- Basal stretches: windows without carbs (from 4 h before), manual boluses
  (from 6 h before), recorded sport (from 6 h before), glucose below 70 or
  sensor gaps.
- Corrections: manual boluses of 0.5 U or more at glucose above 120,
  without carbs from 4 h before to the end of the window and no other
  manual bolus within the window either side.

For both, the observed glucose change is compared with what AAPS's ISF
predicts for all insulin acting beyond the profile basal (glupred/sensitivity.py).
A joint fit gives the basal drift per time of day and one factor k:
actual sensitivity / AAPS's. Repeated for window lengths and insulin curves.

Writes results/sensitivity.md (not committed: derived from health data).
"""

import numpy as np
import pandas as pd

from glupred.actions import insulin_kernel
from glupred.baselines import aaps_decisions
from glupred.features import interpolate
from glupred.load import load
from glupred.sensitivity import acting, joint_fit, none_in, prefix
from train import RESULTS, TEST_FROM, grid_cached

CARB_FREE = 48    # no carbs from 4 h before
BOLUS_FREE = 72   # no manual bolus from 6 h before (basal stretches)
SPORT_FREE = 72
PERIODS = {'night 0–6': (0, 6), 'morning 6–11': (6, 11), 'midday 11–15': (11, 15),
           'afternoon 15–19': (15, 19), 'evening 19–24': (19, 24)}
CURVES = [(55, 360), (65, 420), (75, 480)]  # insulin peak and duration, minutes


def period_of(hour):
    return np.select([(hour >= a) & (hour < b) for a, b in PERIODS.values()], list(PERIODS), 'other')


class Series:
    """The grid as arrays and prefix sums the selections need."""

    def __init__(self, grid):
        self.grid = grid
        self.n = len(grid)
        self.g = interpolate(grid['glucose'].to_numpy(), 2)
        self.manual = np.maximum(grid['bolus'].to_numpy() - grid['smb'].to_numpy(), 0)
        self.net = grid['bolus'].to_numpy() + grid['basal'].to_numpy() - grid['profile_basal'].to_numpy()
        self.isf = aaps_decisions(load('aaps_decisions'), grid.index, fill=12)['isf'].to_numpy()
        self.hour = grid['local_hour'].to_numpy()
        self.year = grid.index.year.to_numpy()
        self.test = grid.index >= pd.Timestamp(TEST_FROM, tz='UTC')
        self.p_carbs = prefix(grid['carbs'].to_numpy())
        self.p_manual = prefix(self.manual)
        self.p_sport = prefix(grid['sport'].to_numpy())
        self.p_gap = prefix(np.isnan(self.g).astype(float))
        self.p_low = prefix((self.g < 70).astype(float))
        self.p_isf_gap = prefix(np.isnan(self.isf).astype(float))

    def frame(self, s, w, curve, kind):
        """observed and expected change over w slots from each start in s."""
        act = acting(self.net, insulin_kernel(peak=curve[0], duration=curve[1]))
        p_expected = prefix(np.nan_to_num(self.isf) * act)
        p_act = prefix(act)
        return pd.DataFrame({
            'kind': kind, 'date': self.grid.index[s], 'glucose': self.g[s],
            'observed': self.g[s + w] - self.g[s],
            'expected': -(p_expected[s + w] - p_expected[s]),
            'acted U': p_act[s + w] - p_act[s],
            'units': self.manual[s], 'AAPS ISF': self.isf[s], 'hours': w / 12,
            'went below 70': ~none_in(self.p_low, s, 0, w + 1),
            'period': period_of((self.hour[s] + w / 24) % 24), 'test': self.test[s], 'year': self.year[s],
        })

    def basal(self, w, curve):
        s = np.arange(BOLUS_FREE, self.n - w, 6)  # every 30 min
        ok = (none_in(self.p_carbs, s, -CARB_FREE, w) & none_in(self.p_manual, s, -BOLUS_FREE, w)
              & none_in(self.p_sport, s, -SPORT_FREE, w) & none_in(self.p_gap, s, 0, w + 1)
              & none_in(self.p_low, s, -12, w + 1) & none_in(self.p_isf_gap, s, 0, w))
        return self.frame(s[ok], w, curve, 'basal')

    def corrections(self, w, curve):
        b = np.where(self.manual >= 0.5)[0]
        b = b[(b > max(CARB_FREE, w)) & (b < self.n - w - 1)]
        others = (self.p_manual[b + w + 1] - self.p_manual[b - w]) - self.manual[b]
        ok = (none_in(self.p_carbs, b, -CARB_FREE, w + 1) & (others == 0) & none_in(self.p_sport, b, -SPORT_FREE, w)
              & none_in(self.p_gap, b, 0, w + 1) & none_in(self.p_isf_gap, b, 0, w) & (self.g[b] > 120))
        return self.frame(b[ok], w, curve, 'correction')


def fit(d):
    return joint_fit(d['observed'].to_numpy(), d['expected'].to_numpy(), d['hours'].to_numpy(), d['period'].to_numpy())


def fit_row(label, d):
    r = fit(d)
    row = {'': label, 'stretches': int((d['kind'] == 'basal').sum()), 'corrections': int((d['kind'] == 'correction').sum()),
           'k (actual / AAPS)': round(r['k'], 2), '90% interval': f"{r['k_lo']:.2f}–{r['k_hi']:.2f}",
           'residual mg/dL': round(r['mae'], 1)}
    for p in PERIODS:
        row[f'drift {p}'] = round(r['drift'].get(p, np.nan), 1)
    return row


def main():
    S = Series(grid_cached(False))
    rows, test_sets = [], {}
    for hours in (2, 3, 4, 5):
        for curve in CURVES:
            d = pd.concat([S.basal(hours * 12, curve), S.corrections(hours * 12, curve)], ignore_index=True)
            t = d[d['test']]
            test_sets[(hours, curve)] = t
            rows.append(fit_row(f'{hours} h, insulin peak {curve[0]} / {curve[1]} min', t))
            print(rows[-1])
    windows = pd.DataFrame(rows)

    main_set = test_sets[(3, CURVES[0])]
    by = []
    for label, d in (('all', main_set), ('without corrections going below 70', main_set[~((main_set['kind'] == 'correction') & main_set['went below 70'])])):
        by.append(fit_row(label, d))
    for lo, hi, label in ((120, 180, 'corrections from 120–180'), (180, 400, 'corrections from > 180')):
        k = (main_set['kind'] == 'basal') | ((main_set['glucose'] > lo) & (main_set['glucose'] <= hi))
        by.append(fit_row(label, main_set[k]))
    years = []
    for y in range(2020, 2027):
        d = pd.concat([S.basal(36, CURVES[0]), S.corrections(36, CURVES[0])], ignore_index=True) if y == 2020 else d
        x = d[d['year'] == y]
        if (x['kind'] == 'correction').sum() >= 15:
            years.append(fit_row(str(y), x))
    corr = main_set[main_set['kind'] == 'correction']
    basal = main_set[main_set['kind'] == 'basal']
    report = '\n'.join([
        '# Basal and insulin sensitivity: AAPS vs observed', '',
        f'Test period from {TEST_FROM}. Observed glucose change against AAPS\'s expectation for all insulin '
        'acting beyond the profile basal (its logged ISF × insulin acting), on basal stretches without carbs or manual '
        'boluses and after correction boluses without carbs. Joint fit: observed = drift(time of day) × hours + '
        'k × expected. k = 1: AAPS\'s ISF is right; below 1: insulin lowers glucose less than AAPS assumes. '
        'drift (mg/dL per hour) > 0: glucose rises at that time of day without extra insulin, so the profile basal is '
        'too low (by about drift / ISF in U/h).', '',
        f'Basal stretches: {len(basal)}; AAPS adds a median {basal["acted U"].median() / basal["hours"].median():.2f} U/h '
        f'beyond the profile in them, glucose changes by a median {basal["observed"].median() / 3:.1f} mg/dL/h. '
        f'Corrections: {len(corr)}, median {corr["units"].median():.1f} U at {corr["glucose"].median():.0f} mg/dL, '
        f'AAPS ISF median {corr["AAPS ISF"].median():.0f} mg/dL/U.', '',
        '## By window and insulin curve', '', windows.to_markdown(index=False), '',
        '## 3 h, peak 55 / 360 min: subsets', '', pd.DataFrame(by).to_markdown(index=False), '',
        '## By year (3 h, peak 55 / 360 min)', '', pd.DataFrame(years).to_markdown(index=False), '',
    ])
    (RESULTS / 'sensitivity.md').write_text(report)
    print(report)


if __name__ == '__main__':
    main()
