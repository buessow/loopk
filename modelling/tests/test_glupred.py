import numpy as np
import pandas as pd

from glupred.actions import carb_kernel, exponential_insulin_iob, insulin_kernel
from glupred.features import committed
from glupred.grid import basal_rates, profile_events, to_minutes
from glupred.metrics import clarke_zone


def test_insulin_kernel_acts_the_whole_dose_and_peaks_near_55_minutes():
    k = insulin_kernel()
    assert abs(k.sum() - 1) < 1e-9
    assert 50 <= 5 * np.argmax(k) + 2.5 <= 60
    assert exponential_insulin_iob(0) == 1 and exponential_insulin_iob(400) == 0


def test_carb_kernel_absorbs_all_carbs_with_its_mode_near_45_minutes():
    k = carb_kernel()
    assert abs(k.sum() - 1) < 1e-9
    assert 35 <= 5 * np.argmax(k) + 2.5 <= 55


def test_committed_activity_uses_only_doses_given_so_far():
    k = insulin_kernel()
    u = np.zeros(100)
    u[10] = 2.0
    # Before the dose nothing is committed; at the dose, past + future activity is the dose.
    assert committed(u, k, 5)[9] == 0
    total = sum(committed(u, k, j)[10] for j in range(len(k)))
    assert abs(total - 2.0) < 1e-9
    # A later dose does not change what was committed earlier.
    later = u.copy()
    later[20] = 5.0
    assert np.allclose(committed(later, k, 3)[:20], committed(u, k, 3)[:20])


def ts(*minutes):
    return pd.to_datetime([m * 60_000 for m in minutes], unit='ms', utc=True)


def test_temp_basals_replace_the_profile_until_their_end_or_the_next_record():
    minutes = np.arange(0, 120, dtype=np.int64)
    profile = np.full(len(minutes), 1.0)
    temps = pd.DataFrame({
        'date': ts(10, 30, 60),
        'duration_ms': [60 * 60_000, 20 * 60_000, np.nan],
        'rate': [2.0, np.nan, np.nan],
        'percent': [np.nan, -50.0, np.nan],
    })
    rates = basal_rates(minutes, profile, temps)
    assert rates[9] == 1.0
    assert rates[10] == 2.0 and rates[29] == 2.0  # cut short by the next temp
    assert rates[30] == 0.5 and rates[49] == 0.5  # percent of the profile
    assert rates[50] == 1.0                      # ended after 20 minutes
    assert rates[60] == 1.0                      # a cancel record applies nothing


def test_temporary_profile_switch_reverts_to_the_permanent_profile():
    stores = pd.DataFrame({
        'date': ts(0), 'default_profile': ['A'], 'name': ['A'], 'schedule': [[[0, 1.0]]],
    })
    switches = pd.DataFrame({
        'date': ts(10, 100),
        'profile': ['A', 'A'],
        'percentage': [100.0, 50.0],
        'timeshift': [0, 0],
        'duration': [0.0, 30.0],
        'schedule': [None, None],
    })
    events = profile_events(switches, stores)
    assert [(e[0], e[2]) for e in events[1:]] == [(10, 100.0), (100, 50.0), (130, 100.0)]
    assert to_minutes(ts(130))[0] == 130


def test_clarke_zones():
    zones = clarke_zone([100, 100, 50, 250, 200], [110, 150, 120, 120, 60])
    assert list(zones) == ['A', 'B', 'D', 'D', 'E']


def test_planned_activity_counts_only_insulin_after_now():
    from glupred.actions import insulin_kernel
    from glupred.whatif import constant_plan, followed, planned_activity
    ik = insulin_kernel()
    u = np.zeros(200)
    u[50] = 1.0
    act = planned_activity(u, ik, 12)
    assert np.allclose(act[50], 0)               # given now: already committed
    assert np.allclose(act[49], ik[:12])          # given in the next slot
    assert np.allclose(constant_plan(np.array([1.0]), ik, 12)[0], np.cumsum(ik)[:12])
    ok = np.ones(20, dtype=bool)
    ok[5] = False
    f = followed(ok, 3)
    assert f[0].all() and not f[4, 0] and f[2, 1] and not f[2, 2]


def test_sport_inputs_count_recorded_minutes_and_time_since():
    from glupred.features import build_features
    n = 400
    idx = pd.date_range('2024-01-01', periods=n, freq='5min', tz='UTC')
    grid = pd.DataFrame({'glucose': 120.0, 'bolus': 0.0, 'basal': 0.0, 'profile_basal': 0.05, 'carbs': 0.0,
                         'hr': 60.0, 'sport': 0.0, 'local_hour': 12.0}, index=idx)
    grid.iloc[100:112, grid.columns.get_loc('sport')] = 1.0
    X, _, _ = build_features(grid, sport=True)
    assert X['sport_1h'].iloc[111] == 60
    assert X['sport_since_h'].iloc[111] == 0 and X['sport_since_h'].iloc[123] == 1.0
    assert X['sport_since_h'].iloc[50] == 24.0
    assert 'sport_1h' not in build_features(grid)[0]


def test_usual_targets_sum_the_window_after_the_slot():
    from glupred.usual import ahead, behind
    a = np.array([1.0, 2, 3, 4, 5])
    assert np.allclose(ahead(a, 2)[:3], [5, 7, 9]) and np.isnan(ahead(a, 2)[3:]).all()
    assert np.allclose(behind(a, 2), [1, 3, 5, 7, 9])


def test_a_second_record_of_the_same_dose_within_a_minute_is_dropped():
    from glupred.grid import dedupe_boluses
    t = pd.Timestamp('2020-03-01T12:00:00Z')
    b = pd.DataFrame({'date': [t, t + pd.Timedelta('1s'), t + pd.Timedelta('20s'), t + pd.Timedelta('4min')],
                      'insulin': [0.3, 0.3, 1.0, 0.3], 'smb': [False, True, False, True]})
    kept = dedupe_boluses(b)
    assert kept['insulin'].tolist() == [0.3, 1.0, 0.3]
    assert kept['smb'].tolist() == [True, False, True]


def test_duplicate_carb_entries_are_dropped():
    from glupred.grid import dedupe
    t = pd.Timestamp('2020-03-01T12:00:00Z')
    c = pd.DataFrame({'date': [t, t + pd.Timedelta('2s'), t + pd.Timedelta('10s'), t + pd.Timedelta('5min')],
                      'carbs': [30.0, 30.0, 10.0, 30.0]})
    assert dedupe(c, 'carbs', 0.5)['carbs'].tolist() == [30.0, 10.0, 30.0]


def synthetic_grid(n=200):
    rng = np.random.default_rng(0)
    index = pd.date_range('2025-01-01', periods=n, freq='5min', tz='UTC')
    return pd.DataFrame({
        'glucose': 120 + np.cumsum(rng.normal(0, 2, n)), 'bolus': np.where(np.arange(n) % 40 == 0, 1.0, 0.0),
        'basal': np.full(n, 0.08), 'profile_basal': np.full(n, 0.07), 'carbs': np.where(np.arange(n) % 60 == 5, 30.0, 0.0),
        'hr': np.full(n, 70.0), 'local_hour': (np.arange(n) * 5 / 60) % 24, 'sport': np.zeros(n)}, index=index)


def test_an_added_dose_changes_inputs_and_glucose_as_a_logged_one_would():
    from glupred.features import build_features
    from glupred.synthetic import acted, add_insulin
    grid = synthetic_grid(300)
    horizons, i, drop = 24, 150, 30.0
    X, Y, _ = build_features(grid, horizons=horizons)
    effect = acted(insulin_kernel(peak=60, duration=240), 100)
    for ago in (0, 7, 23):
        dosed = grid.copy()
        dosed.iloc[i - ago, dosed.columns.get_loc('bolus')] += 2.0
        # The glucose the dose would have lowered, from the slot after it on.
        m = np.arange(len(grid)) - (i - ago)
        dosed['glucose'] -= drop * np.where(m >= 0, effect[np.clip(m, 0, len(effect) - 1)], 0.0)
        X2, Y2, _ = build_features(dosed, horizons=horizons)
        x, y = add_insulin(X.iloc[[i]], Y.iloc[[i]].to_numpy(), np.array([2.0]), np.array([ago]),
                           np.array([drop]), insulin_kernel(), effect)
        assert np.allclose(x[0], X2.iloc[i].to_numpy(), equal_nan=True)
        assert np.allclose(y[0], Y2.iloc[i].to_numpy())


def test_glucose_lowered_by_an_added_dose_stops_at_the_sensor_minimum():
    from glupred.synthetic import SENSOR_MIN, acted, add_insulin
    X = pd.DataFrame({'g_now': [60.0], 'gd_1': [5.0]})
    _, y = add_insulin(X, np.zeros((1, 72)), np.array([5.0]), np.array([0]), np.array([200.0]),
                       insulin_kernel(), acted(insulin_kernel(), 80))
    assert y[0, -1] == SENSOR_MIN - 60


def test_calibration_makes_the_mean_forecast_unbiased_on_validation():
    from glupred.nn import Model
    rng = np.random.default_rng(0)
    n = 4000
    X = rng.normal(size=(n, 3))
    g = np.full(n, 120.0)
    Y = g[:, None] * (np.exp(0.3 * rng.normal(size=(n, 2))) - 1)  # noisy log changes around 0
    mask = np.ones((n, 2), dtype=bool)
    args = (X[:3000], g[:3000], Y[:3000], mask[:3000], None, X[3000:], g[3000:], Y[3000:], mask[3000:], None)
    raw = Model(quantiles=(), calibrate=False).fit(*args, epochs=3, log=lambda *_: None)
    cal = Model(quantiles=()).fit(*args, epochs=3, log=lambda *_: None)
    actual = (Y + g[:, None])[3000:]
    assert np.mean(raw.predict(X[3000:], g[3000:])['mean'] - actual) < -3
    assert abs(np.mean(cal.predict(X[3000:], g[3000:])['mean'] - actual)) < 0.5
