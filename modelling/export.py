"""Trains the 15/30-minute model the server runs, exports it as JSON and
uploads it.

    uv run python export.py                            # train, write results/model.json
    uv run python export.py --upload https://loopk.example.com --token <token>   # train and upload
    uv run python upload.py --url URL --token <token>                           # upload results/model.json

URL and token can also come from LOOPK_URL and LOOPK_MODEL_TOKEN.

Inputs are the last 2 h of glucose and the time of day only; insulin, carbs
and heart rate add little at these horizons (FINDINGS.md, Server model).
The model is derived from health data, so it stays out of the repository:
it goes to results/model.json and to the server, via an "Upload model"
access token (Access page). It bundles checks, synthetic readings with the
Python outputs, which the server reproduces before accepting it.

Also writes ../test/fixtures/prediction.json for the server's parity test:
the same synthetic readings run through a random network of the same shape.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from glupred.features import HISTORY, build_features, interpolate
from glupred.grid import FALLBACK_TZ, SLOT_MIN, _slot_mean, local_offsets, to_minutes
from glupred.metrics import summarize
from glupred.nn import Model, Net
from glupred.scenarios import crossings, low_event, warning_episodes
from glupred.upload import upload
from train import RESULTS, TEST_FROM, TRAIN_FROM, VALIDATION_FROM, grid_cached, period

ROOT = Path(__file__).resolve().parent.parent
MODEL_FILE = RESULTS / 'model.json'
FIXTURE = ROOT / 'test' / 'fixtures' / 'prediction.json'
INPUTS = ['g_now'] + [f'gd_{lag}' for lag in range(1, HISTORY)] + ['hour_sin', 'hour_cos']
HORIZONS = 6
QUANTILES = (0.1, 0.9)
EVENTS = ('p_low_30',)
LOW_WARNING = 0.4


def glucose_grid(glucose):
    """The grid columns the inputs use, built like grid.build_grid, from a
    glucose frame (date, sgv, utc_offset)."""
    first = to_minutes(glucose['date'][:1])[0] // SLOT_MIN * SLOT_MIN
    last = to_minutes(glucose['date'][-1:])[0] // SLOT_MIN * SLOT_MIN + SLOT_MIN
    minutes = np.arange(first, last, dtype=np.int64)
    slots = minutes[::SLOT_MIN]
    n = len(slots)
    idx = (to_minutes(glucose['date']) - first) // SLOT_MIN
    offsets = local_offsets(minutes, glucose)
    zero = np.zeros(n)
    return pd.DataFrame({
        'glucose': _slot_mean(idx, glucose['sgv'].to_numpy(dtype=float), n),
        'bolus': zero, 'basal': zero, 'profile_basal': zero, 'carbs': zero, 'hr': np.full(n, np.nan),
        'local_hour': ((slots + offsets[::SLOT_MIN]) % 1440) / 60,
    }, index=pd.DatetimeIndex(slots * 60_000_000_000, tz='UTC', name='date'))


def export_model(model, metrics):
    net = model.net
    layers = [m for m in list(net.trunk) + [net.head] if hasattr(m, 'weight')]
    return {
        'version': pd.Timestamp.now(tz='UTC').strftime('%Y-%m-%d'),
        'description': 'MLP on the last 2 h of glucose and the time of day; see modelling/FINDINGS.md',
        'slotMinutes': SLOT_MIN, 'history': HISTORY, 'interpolateSlots': 2, 'fallbackTimeZone': FALLBACK_TZ,
        'inputs': INPUTS, 'horizons': HORIZONS, 'quantiles': list(QUANTILES), 'events': list(EVENTS),
        'lowWarning': LOW_WARNING,
        'mean': [float(v) for v in model.mu], 'scale': [float(v) for v in model.sd],
        'targetScale': [float(v) for v in model.ysd],
        'layers': [{'weights': np.round(m.weight.detach().numpy().astype(float), 7).tolist(),
                    'bias': np.round(m.bias.detach().numpy().astype(float), 7).tolist()} for m in layers],
        'metrics': metrics,
    }


def synthetic_cases(rng):
    """Readings that exercise slot means, interpolation, gaps and offsets."""
    end = pd.Timestamp('2026-03-29T00:52:30Z')  # around the start of summer time
    cases = []
    for name, shape, offset in (
            ('steady', lambda t: 110 + 0 * t, 60),
            ('falling', lambda t: 180 - 0.9 * t, 120),
            ('rising after a low', lambda t: 60 + 0.002 * t ** 2, None),
            ('wavy', lambda t: 140 + 40 * np.sin(t / 25), 60)):
        for variant in ('regular', 'jitter and duplicates', 'two missing slots', 'three missing slots'):
            t = np.arange(-150, 1, 5.0)
            if variant == 'jitter and duplicates':
                t = np.sort(np.concatenate([t + rng.uniform(-2, 2, len(t)), [-62.0, -61.0]]))
            if variant == 'two missing slots':
                t = t[(t < -50) | (t >= -40)]
            if variant == 'three missing slots':
                t = t[(t < -50) | (t >= -35)]
            t[-1] = 0.0
            dates = end + pd.to_timedelta(t, unit='min')
            sgv = np.clip(np.round(shape(t + 150)), 40, 400)
            cases.append({'name': f'{name}, {variant}', 'readings': pd.DataFrame(
                {'date': dates, 'sgv': sgv, 'utc_offset': offset}).astype({'utc_offset': 'float'})})
    return cases


def train():
    """The model and its test metrics."""
    grid = grid_cached(False)
    X, Y, info = build_features(grid, rescue={}, horizons=HORIZONS)
    valid = info['valid'].to_numpy()
    tr = valid & period(X.index, TRAIN_FROM, VALIDATION_FROM)
    va = valid & period(X.index, VALIDATION_FROM, TEST_FROM)
    te = valid & period(X.index, TEST_FROM)
    A = X[INPUTS].to_numpy()
    g = X['g_now'].to_numpy()
    Yn = Y.to_numpy()
    actual = Yn + g[:, None]
    mask = np.ones_like(Yn, dtype=bool)
    E = low_event(actual, g)[:, None].astype(np.float32)
    model = Model(quantiles=QUANTILES, events=EVENTS).fit(
        A[tr], g[tr], Yn[tr], mask[tr], E[tr], A[va], g[va], Yn[va], mask[va], E[va], log=lambda *_: None)

    p = model.predict(A[te], g[te])
    s = summarize('server model', actual[te], p['mean'], (15, 30), (15, 30))
    metrics = {'test': f'{TEST_FROM} – {X.index[te][-1]:%Y-%m-%d}', 'samples': int(te.sum())}
    for m in (15, 30):
        k = m // 5 - 1
        inside = (actual[te][:, k] >= p['q0.1'][:, k]) & (actual[te][:, k] <= p['q0.9'][:, k])
        metrics[f'{m} min'] = {'MAE': round(s[f'MAE{m}'], 1), 'P90': round(s[f'P90_{m}'], 1),
                               'Clarke A %': round(s[f'A{m}%'], 1), '80% band holds %': round(100 * inside.mean(), 1)}
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
    model.mu = np.array([120.0] + [0.0] * (HISTORY - 1) + [0.0, 0.0])
    model.sd = np.array([40.0] + [5.0 * np.sqrt(lag) for lag in range(1, HISTORY)] + [0.7, 0.7])
    model.ysd = 0.02 * np.arange(1, HORIZONS + 1)
    return model


def run_cases(model):
    """Synthetic readings with their inputs and the model's outputs."""
    cases = []
    for case in synthetic_cases(np.random.default_rng(1)):
        r = case['readings']
        Xc, _, _ = build_features(glucose_grid(r), horizons=HORIZONS)
        row = Xc[INPUTS].iloc[-1]
        ok = bool(row.notna().all())
        expected = None
        if ok:
            x = row.to_numpy()[None, :]
            pc = model.predict(x, x[:, :1].ravel())
            expected = {'mean': pc['mean'][0].tolist(), 'q0.1': pc['q0.1'][0].tolist(),
                        'q0.9': pc['q0.9'][0].tolist(), 'p_low_30': float(pc['p_low_30'][0])}
        cases.append({
            'name': case['name'],
            'readings': [{'date': int(d.value // 1_000_000), 'sgv': float(v),
                          **({} if np.isnan(o) else {'utcOffset': int(o)})}
                         for d, v, o in zip(r['date'], r['sgv'], r['utc_offset'])],
            'slot': int(Xc.index[-1].value // 1_000_000),
            'inputs': [None if np.isnan(v) else float(v) for v in row.to_numpy()],
            'available': ok,
            'expected': expected,
        })
    return cases


def with_checks(exported, cases):
    exported['checks'] = [{k: c[k] for k in ('name', 'readings', 'expected')} for c in cases if c['available']]
    return exported


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', metavar='URL', nargs='?', const='', default=None,
                    help='upload the model to this loopk server (default: $LOOPK_URL)')
    ap.add_argument('--token', help='"Upload model" access token (default: $LOOPK_MODEL_TOKEN)')
    ap.add_argument('--no-train', action='store_true', help=f'use the existing {MODEL_FILE.name}')
    args = ap.parse_args()

    if args.no_train:
        exported = json.loads(MODEL_FILE.read_text())
    else:
        model, metrics = train()
        print(json.dumps(metrics, indent=1, ensure_ascii=False))
        exported = with_checks(export_model(model, metrics), run_cases(model))
        RESULTS.mkdir(exist_ok=True)
        MODEL_FILE.write_text(json.dumps(exported, separators=(',', ':'), ensure_ascii=False))
        print(f'wrote {MODEL_FILE} ({MODEL_FILE.stat().st_size // 1024} kB)')

        fake = random_model()
        cases = run_cases(fake)
        fixture = with_checks(export_model(fake, {}), cases)
        fixture['version'] = 'random-test-model'
        FIXTURE.parent.mkdir(exist_ok=True)
        FIXTURE.write_text(json.dumps({'note': 'Synthetic readings and a random network; generated by modelling/export.py',
                                       'model': fixture, 'cases': cases}, separators=(',', ':')))
        print(f'wrote {FIXTURE} ({len(cases)} cases, {sum(c["available"] for c in cases)} with a prediction)')
    if args.upload is not None:
        upload(exported, args.upload or None, args.token)


if __name__ == '__main__':
    main()
