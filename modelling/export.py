"""Trains the 15/30-minute model the server runs, exports it as JSON and
uploads it.

    uv run python export.py                            # train, write results/model.json
    uv run python export.py --upload https://loopk.example.com --token <token>   # train and upload
    uv run python upload.py --url URL --token <token>                           # upload results/model.json

URL and token can also come from LOOPK_URL and LOOPK_MODEL_TOKEN.

Inputs: the last 2 h of glucose, its mean over the last 1, 3 and 7 days,
the time of day, and the activity of insulin and carbs (with assumed rescue
carbs) in the past, committed for the next 30 minutes, and on board. The
model trains with synthetic insulin copies (glupred/synthetic.py), so that
more insulin lowers the forecast (benchmark candidate
server-insulin-carbs-synthetic; FINDINGS.md, Standard benchmark).

The model is derived from health data, so it stays out of the repository:
it goes to results/model.json and to the server, via an "Upload model"
access token (Access page). It bundles checks: synthetic readings and
treatments with the Python outputs, which the server reproduces from the
raw records (src/predict/grid.js) before accepting it.

Also writes ../test/fixtures/prediction.json for the server's parity test:
the same synthetic records run through a random network of the same shape.
"""

import argparse
import inspect
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from glupred.actions import carb_kernel, insulin_kernel
from glupred.features import (HISTORY, INSULIN_STALE_SLOTS, LEVEL_DAYS, LEVEL_FALLBACK, LOW, activity_inputs,
                              build_features, interpolate, rescue_carbs)
from glupred.grid import DUPLICATE_SECONDS, FALLBACK_TZ, SLOT_MIN, build_grid
from glupred.metrics import summarize
from glupred.nn import Model, Net
from glupred.scenarios import crossings, low_event, warning_episodes
from glupred.synthetic import copies, moments
from glupred.upload import upload
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

ROOT = Path(__file__).resolve().parent.parent
MODEL_FILE = RESULTS / 'model.json'
FIXTURE = ROOT / 'test' / 'fixtures' / 'prediction.json'
HORIZONS = 6
GLUCOSE_INPUTS = ['g_now'] + [f'gd_{lag}' for lag in range(1, HISTORY)] + ['hour_sin', 'hour_cos']
LEVEL_INPUTS = [f'g_mean_{d}d' for d in LEVEL_DAYS]
INPUTS = (GLUCOSE_INPUTS + LEVEL_INPUTS + activity_inputs('ia', 'iob', HORIZONS) + ['profile_basal']
          + activity_inputs('ca', 'cob', HORIZONS))
SYNTHETIC = ('random', 'peak', 'meal')
QUANTILES = (0.1, 0.9)
EVENTS = ('p_low_30',)
LOW_WARNING = 0.3  # about the share of lows the glucose-only model announced at 0.4, with fewer false alarms
RESCUE = {k: v.default for k, v in inspect.signature(rescue_carbs).parameters.items() if v.default is not inspect.Parameter.empty}
DUPLICATES = {'seconds': DUPLICATE_SECONDS, 'insulin': 0.011, 'carbs': 0.5}  # grid.dedupe_boluses, build_grid


def export_model(model, metrics):
    net = model.net
    layers = [m for m in list(net.trunk) + [net.head] if hasattr(m, 'weight')]
    return {
        'version': pd.Timestamp.now(tz='UTC').strftime('%Y-%m-%d'),
        'description': 'MLP on 2 h of glucose, its 1/3/7-day mean, the time of day, insulin and carbs, '
                       'trained with synthetic insulin data; see modelling/FINDINGS.md',
        'slotMinutes': SLOT_MIN, 'history': HISTORY, 'interpolateSlots': 2, 'fallbackTimeZone': FALLBACK_TZ,
        'inputs': INPUTS, 'horizons': HORIZONS, 'quantiles': list(QUANTILES), 'events': list(EVENTS),
        'lowWarning': LOW_WARNING,
        'levelDays': list(LEVEL_DAYS), 'levelFallback': LEVEL_FALLBACK,
        'insulinKernel': insulin_kernel().tolist(), 'carbKernel': carb_kernel().tolist(),
        'insulinStaleSlots': INSULIN_STALE_SLOTS,
        'rescueCarbs': {'low': LOW, 'grams': RESCUE['grams'], 'aboveSlots': RESCUE['above_slots'],
                        'quietSlots': RESCUE['quiet_slots']},
        'duplicates': DUPLICATES,
        'mean': [float(v) for v in model.mu], 'scale': [float(v) for v in model.sd],
        'targetScale': [float(v) for v in model.ysd],
        'layers': [{'weights': np.round(m.weight.detach().numpy().astype(float), 7).tolist(),
                    'bias': np.round(m.bias.detach().numpy().astype(float), 7).tolist()} for m in layers],
        'metrics': metrics,
    }


# --- Synthetic records for the parity checks

END = pd.Timestamp('2026-03-29T03:02:30Z')  # two hours after the start of summer time
MIN_MS = 60_000

SCHEDULE_A = [[0, 0.8], [21600, 1.1], [43200, 0.9], [72000, 1.0]]
SCHEDULE_B = [[0, 0.5], [28800, 0.7]]
SCHEDULE_NEW = [[0, 0.9], [36000, 1.2]]


def _ms(minutes):
    """Epoch ms `minutes` (may be fractional) before or after END."""
    return int(END.value // 1_000_000 + round(minutes * MIN_MS))


STORES = [
    {'date': _ms(-30 * 1440), 'defaultProfile': 'Default', 'name': 'Default', 'schedule': SCHEDULE_A},
    {'date': _ms(-30 * 1440), 'defaultProfile': 'Default', 'name': 'Sport', 'schedule': SCHEDULE_B},
    {'date': _ms(-2 * 1440), 'defaultProfile': 'Default', 'name': 'Default', 'schedule': SCHEDULE_NEW},
]


def _treatments(profile_switches=(), stores=STORES):
    """Boluses (with a duplicate SMB), an extended bolus, temp basals
    (absolute, percent, cancel, running now) and carbs (with a duplicate)."""
    return {
        'boluses': [{'date': _ms(m), 'insulin': u} for m, u in (
            (-400, 3.0), (-200, 0.3), (-199.98, 0.3), (-150, 0.31), (-90, 1.5), (-20, 0.5), (-3, 0.2))],
        'extended': [{'date': _ms(-360), 'insulin': 2.0, 'duration': 180.0}],
        'tempBasals': [{'date': _ms(m), 'durationMs': d, 'rate': r, 'percent': p} for m, d, r, p in (
            (-480, 30 * MIN_MS, 0.0, None), (-300, 60 * MIN_MS, None, 50.0), (-250, None, None, None),
            (-170, 20.5 * MIN_MS, 1.5, None), (-100, 120 * MIN_MS, 2.0, None))],
        'carbs': [{'date': _ms(m), 'carbs': c} for m, c in ((-410, 45.0), (-409.99, 45.0), (-120, 10.0))],
        'profileSwitches': [{'date': _ms(m), 'profile': name, 'percentage': pct, 'timeshift': shift,
                             'duration': duration, 'schedule': schedule}
                            for m, name, pct, shift, duration, schedule in profile_switches],
        'profileStores': list(stores),
    }


def _no_treatments():
    return {k: [] for k in ('boluses', 'extended', 'tempBasals', 'carbs', 'profileSwitches', 'profileStores')}


def synthetic_cases(rng):
    """Readings and treatments that exercise slot means, interpolation, gaps,
    time zones, the glucose level, deduplication, temp basals, extended
    boluses, profile switches and stores, and assumed rescue carbs."""
    def readings(shape, days=0.6, offset=60, jitter=False, drop=None, offsets=None):
        t = -np.arange(0, days * 1440 + 1, 5.0)[::-1]  # every 5 min up to now
        if jitter:
            t = np.sort(np.concatenate([t + rng.uniform(-2, 2, len(t)), [-62.0, -61.0]]))
        if drop is not None:
            t = t[(t < drop[0]) | (t >= drop[1])]
        t[-1] = 0.0
        sgv = np.clip(np.round(shape(t)), 40, 400)
        out = []
        for m, v in zip(t, sgv):
            o = offsets(m) if offsets else offset
            out.append({'date': _ms(m), 'sgv': int(v), **({} if o is None else {'utcOffset': int(o)})})
        return out

    steady = lambda t: 110 + 0 * t
    wavy = lambda t: 140 + 40 * np.sin(t / 25)
    falling = lambda t: 150 + 30 * np.sin(t / 200) - np.clip(t + 120, 0, None) * 0.8
    rising = lambda t: 90 + 30 * np.cos(t / 90) + np.clip(t + 60, 0, None) * 1.2
    low = lambda t: np.where(t < -60, 120 + 20 * np.sin(t / 60), 62 + 0.4 * (t + 60))
    by_name = [(-1000, 'Default', 100.0, 0, 0.0, None)]
    return [
        ('steady, no treatments: insulin unknown', readings(steady), _no_treatments()),
        ('wavy, stored default profile', readings(wavy), _treatments()),
        ('falling, embedded schedule at 120% shifted 2 h, two missing slots',
         readings(falling, drop=(-50, -40)), _treatments([(-700, 'Mine', 120.0, 2, 0.0, SCHEDULE_A)])),
        ('rising, temporary switch that reverts',
         readings(rising), _treatments(by_name + [(-200, 'Sport (80%)', 80.0, 0, 60.0, None)])),
        ('wavy, temporary switch until the next one',
         readings(wavy), _treatments(by_name + [(-300, 'Sport', 100.0, -1, 120.0, None),
                                                (-260, 'Default', 90.0, 0, 0.0, None)])),
        ('rising, switch by name to the newer store, jitter and duplicates',
         readings(rising, jitter=True), _treatments(by_name)),
        ('falling into a low: assumed rescue carbs', readings(low), _treatments(by_name)),
        ('wavy, three missing slots', readings(wavy, drop=(-50, -35)), _treatments(by_name)),
        ('wavy, 3.6 days: the glucose level', readings(wavy, days=3.6), _treatments(by_name)),
        ('rising, fallback time zone across the summer-time change',
         readings(rising, offset=None), _treatments([(-900, 'Mine', 100.0, 0, 0.0, SCHEDULE_A)])),
        ('falling, travel: the uploader offset changes',
         readings(falling, offsets=lambda m: 60 if m < -240 else -240), _treatments(by_name)),
        ('steady, no profile at all', readings(steady), _treatments(stores=())),
    ]


def _frames(readings, t):
    """The records as the DataFrames glupred.grid.build_grid reads."""
    date = lambda rows: pd.to_datetime([r['date'] for r in rows], unit='ms', utc=True)
    nan = lambda v: np.nan if v is None else v
    g = pd.DataFrame({'date': date(readings), 'sgv': [r['sgv'] for r in readings],
                      'utc_offset': [r.get('utcOffset', np.nan) for r in readings]}).astype({'utc_offset': float})
    return {
        'glucose': g.sort_values('date', kind='stable').reset_index(drop=True),
        'boluses': pd.DataFrame({'date': date(t['boluses']), 'insulin': [r['insulin'] for r in t['boluses']],
                                 'smb': [False] * len(t['boluses'])}),
        'extended': pd.DataFrame({'date': date(t['extended']), 'insulin': [r['insulin'] for r in t['extended']],
                                  'duration': [r['duration'] for r in t['extended']]}),
        'temp_basals': pd.DataFrame({'date': date(t['tempBasals']),
                                     'duration_ms': [nan(r['durationMs']) for r in t['tempBasals']],
                                     'rate': [nan(r['rate']) for r in t['tempBasals']],
                                     'percent': [nan(r['percent']) for r in t['tempBasals']]}).astype(
            {'duration_ms': float, 'rate': float, 'percent': float}),
        'carbs': pd.DataFrame({'date': date(t['carbs']), 'carbs': [r['carbs'] for r in t['carbs']]}),
        'profile_switches': pd.DataFrame({
            'date': date(t['profileSwitches']), 'profile': [r['profile'] for r in t['profileSwitches']],
            'percentage': [r['percentage'] for r in t['profileSwitches']],
            'timeshift': [r['timeshift'] for r in t['profileSwitches']],
            'duration': [r['duration'] for r in t['profileSwitches']],
            'schedule': pd.Series([r['schedule'] for r in t['profileSwitches']], dtype=object)}),
        'profile_stores': pd.DataFrame({
            'date': date(t['profileStores']), 'default_profile': [r['defaultProfile'] for r in t['profileStores']],
            'name': [r['name'] for r in t['profileStores']],
            'schedule': pd.Series([r['schedule'] for r in t['profileStores']], dtype=object)}),
        'heartrate': pd.DataFrame({'date': pd.to_datetime([], utc=True), 'bpm': [], 'duration_ms': [], 'sport': []}),
    }


def run_cases(model):
    """Synthetic records with their inputs and the model's outputs."""
    cases = []
    for name, readings, treatments in synthetic_cases(np.random.default_rng(1)):
        grid = build_grid(_frames(readings, treatments))
        Xc, _, info = build_features(grid, rescue={}, horizons=HORIZONS, level=True)
        row = Xc[INPUTS].iloc[-1]
        ok = bool(row.notna().all() and info['insulin_known'].iloc[-1])
        expected = None
        if ok:
            x = row.to_numpy()[None, :]
            pc = model.predict(x, x[:, :1].ravel())
            expected = {'mean': pc['mean'][0].tolist(), 'q0.1': pc['q0.1'][0].tolist(),
                        'q0.9': pc['q0.9'][0].tolist(), 'p_low_30': float(pc['p_low_30'][0])}
        cases.append({
            'name': name,
            'readings': readings,
            'treatments': treatments,
            'slot': int(Xc.index[-1].value // 1_000_000),
            'inputs': [None if np.isnan(v) else float(v) for v in row.to_numpy()],
            'available': ok,
            'expected': expected,
        })
    return cases


def with_checks(exported, cases):
    exported['checks'] = [{k: c[k] for k in ('name', 'readings', 'treatments', 'expected')}
                          for c in cases if c['available']]
    return exported


# --- Training


def train():
    """The model and its test metrics."""
    grid = grid_cached(False)
    X, Y, info = build_features(grid, rescue={}, horizons=HORIZONS, level=True)
    valid = info['valid'].to_numpy()
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    cols = [X.columns.get_loc(c) for c in INPUTS]
    A = X[INPUTS].to_numpy()
    g = X['g_now'].to_numpy()
    Yn = Y.to_numpy()
    actual = Yn + g[:, None]
    m = moments(grid, X)

    def part(sel, seed):
        """Real samples and their synthetic insulin copies."""
        rows = [(A[sel], g[sel], Yn[sel], low_event(actual[sel], g[sel]))]
        for s, kind in enumerate(SYNTHETIC):
            xs, ys, _ = copies(kind, X, Yn, sel, m, seed + s, HORIZONS)
            rows.append((xs[:, cols], xs[:, 0], ys, low_event(ys + xs[:, :1], xs[:, 0])))
        x, gn, y, e = [np.concatenate(p) for p in zip(*rows)]
        return x, gn, y, np.ones_like(y, dtype=bool), e[:, None].astype(np.float32)

    model = Model(quantiles=QUANTILES, events=EVENTS).fit(*part(tr, 1), *part(va, 11), log=lambda *_: None)

    p = model.predict(A[te], g[te])
    s = summarize('server model', actual[te], p['mean'], (15, 30), (15, 30))
    metrics = {'test': f'{TEST_FROM} – {X.index[te][-1]:%Y-%m-%d}', 'samples': int(te.sum())}
    for minutes in (15, 30):
        k = minutes // 5 - 1
        inside = (actual[te][:, k] >= p['q0.1'][:, k]) & (actual[te][:, k] <= p['q0.9'][:, k])
        metrics[f'{minutes} min'] = {'MAE': round(s[f'MAE{minutes}'], 1), 'P90': round(s[f'P90_{minutes}'], 1),
                                     'Clarke A %': round(s[f'A{minutes}%'], 1),
                                     '80% band holds %': round(100 * inside.mean(), 1)}
    glucose = interpolate(grid['glucose'].to_numpy(), 2)
    lows = crossings(glucose)
    weeks = te.sum() * 5 / 60 / 24 / 7
    idx = np.where(te)[0]
    lows = lows[(lows > idx[0]) & te[np.maximum(lows - 1, 0)]]
    for thr in (0.2, 0.3, 0.4, 0.5):
        warn = np.zeros(len(X), dtype=bool)
        warn[idx] = (p['p_low_30'] >= thr) & (g[te] >= 70)
        r = warning_episodes(warn, lows, weeks)
        metrics[f'low warning at {thr}'] = {k: round(float(v), 1) for k, v in r.items()}
    return model, metrics


def random_model():
    """A network of the server model's shape with seeded random weights and
    plausible scaling: exercises the same code, derived from no data."""
    torch.manual_seed(0)
    model = Model(quantiles=QUANTILES, events=EVENTS)
    model.net = Net(len(INPUTS), HORIZONS, QUANTILES, EVENTS)

    def scaling(name):
        if name == 'g_now' or name.startswith('g_mean_'):
            return 120.0, 40.0
        if name.startswith('gd_'):
            return 0.0, 5.0 * np.sqrt(int(name[3:]))
        if name.startswith('ia_'):
            return 0.01, 0.02
        if name.startswith('ca_'):
            return 0.3, 1.0
        return {'iob': (1.0, 2.0), 'cob': (10.0, 20.0), 'profile_basal': (1.0, 0.3)}.get(name, (0.0, 0.7))

    model.mu, model.sd = (np.array(v) for v in zip(*map(scaling, INPUTS)))
    model.ysd = 0.02 * np.arange(1, HORIZONS + 1)
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', metavar='URL', nargs='?', const='', default=None,
                    help='upload the model to this loopk server (default: $LOOPK_URL)')
    ap.add_argument('--token', help='"Upload model" access token (default: $LOOPK_MODEL_TOKEN)')
    ap.add_argument('--no-train', action='store_true', help=f'use the existing {MODEL_FILE.name}')
    ap.add_argument('--fixture-only', action='store_true', help='only write the test fixture (no data needed)')
    args = ap.parse_args()

    if not args.no_train or args.fixture_only:
        fake = random_model()
        cases = run_cases(fake)
        fixture = with_checks(export_model(fake, {}), cases)
        fixture['version'] = 'random-test-model'
        FIXTURE.parent.mkdir(exist_ok=True)
        FIXTURE.write_text(json.dumps({'note': 'Synthetic records and a random network; generated by modelling/export.py',
                                       'model': fixture, 'cases': cases}, separators=(',', ':')))
        print(f'wrote {FIXTURE} ({len(cases)} cases, {sum(c["available"] for c in cases)} with a prediction)')
    if args.fixture_only:
        return
    if args.no_train:
        exported = json.loads(MODEL_FILE.read_text())
    else:
        model, metrics = train()
        print(json.dumps(metrics, indent=1, ensure_ascii=False))
        exported = with_checks(export_model(model, metrics), run_cases(model))
        RESULTS.mkdir(exist_ok=True)
        MODEL_FILE.write_text(json.dumps(exported, separators=(',', ':'), ensure_ascii=False))
        print(f'wrote {MODEL_FILE} ({MODEL_FILE.stat().st_size // 1024} kB)')
    if args.upload is not None:
        upload(exported, args.upload or None, args.token)


if __name__ == '__main__':
    main()
