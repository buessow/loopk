"""Puts the raw series on a common 5-minute grid.

Slot i covers [t_i, t_i + 5 min). Per slot: mean glucose (mg/dL), insulin
delivered as boluses and as basal (U), carbs (g), mean heart rate (bpm), and
the local hour of day. Basal delivery is integrated at 1-minute resolution
from the profile in effect and the temp basals.
"""

import re

import numpy as np
import pandas as pd

SLOT_MIN = 5
FALLBACK_TZ = 'Europe/Zurich'


def to_minutes(dates):
    """UTC datetimes as integer minutes since the epoch (floored)."""
    return (pd.DatetimeIndex(dates).as_unit('ms').asi8 // 60_000).astype(np.int64)


def local_offsets(minutes, glucose):
    """UTC offset (minutes) for every minute: the uploader's offset where
    known, else the fallback time zone's."""
    utc = pd.DatetimeIndex(minutes * 60_000_000_000, tz='UTC')
    local = utc.tz_convert(FALLBACK_TZ).tz_localize(None).as_unit('ns')
    offsets = ((local.asi8 - utc.tz_localize(None).as_unit('ns').asi8) // 60_000_000_000).astype(np.float64)
    known = glucose.dropna(subset=['utc_offset'])
    if len(known):
        idx = np.searchsorted(to_minutes(known['date']), minutes, side='right') - 1
        recent = idx >= 0
        last_known = np.where(recent, to_minutes(known['date'])[np.clip(idx, 0, None)], 0)
        valid = recent & (minutes - last_known <= 24 * 60)
        offsets[valid] = known['utc_offset'].to_numpy()[idx[valid]]
    return offsets.astype(np.int64)


_PCT_SUFFIX = re.compile(r'\s*\(\d+%\)$')


def profile_events(switches, stores):
    """Basal schedule in effect over time: [(minute, schedule, pct, shift_h)].

    A schedule is a sorted array of (seconds from midnight, U/h). A switch
    without an embedded schedule uses the newest stored profile of that name;
    a temporary switch (duration > 0) reverts to the previous permanent one.
    """
    stores = stores.sort_values('date')
    store_minutes = to_minutes(stores['date'])

    def stored(name, minute):
        if name is None or (isinstance(name, float) and np.isnan(name)):
            return None
        rows = stores[(stores['name'] == _PCT_SUFFIX.sub('', name)) & (store_minutes <= minute)]
        return None if rows.empty else rows['schedule'].iloc[-1]

    first = stores.iloc[0] if len(stores) else None
    current = None
    if first is not None:
        default = stores[(stores['date'] == first['date']) & (stores['name'] == first['default_profile'])]
        current = (np.iinfo(np.int64).min, _schedule(default['schedule'].iloc[0] if len(default) else first['schedule']), 100.0, 0)
    events = [current] if current else []
    permanent = current
    rows = switches.sort_values('date').reset_index(drop=True)
    minutes = to_minutes(rows['date'])
    for i, sw in rows.iterrows():
        m = int(minutes[i])
        raw = sw['schedule'] if sw['schedule'] is not None else stored(sw['profile'], m)
        schedule = _schedule(raw) if raw is not None else (current[1] if current else None)
        if schedule is None:
            continue
        current = (m, schedule, float(sw['percentage']), int(sw['timeshift']))
        events.append(current)
        duration = float(sw['duration'] or 0)
        if duration > 0 and permanent is not None:
            end = m + int(duration)
            next_m = minutes[i + 1] if i + 1 < len(rows) else np.iinfo(np.int64).max
            if end < next_m:
                events.append((end, *permanent[1:]))
                current = (end, *permanent[1:])
        else:
            permanent = current
    return events


def _schedule(raw):
    s = np.array(sorted((int(a), float(b)) for a, b in raw), dtype=np.float64)
    return s if len(s) else None


def profile_rates(minutes, offsets, events):
    """Profile basal rate (U/h) for every minute."""
    rates = np.full(len(minutes), np.nan)
    starts = np.array([e[0] for e in events], dtype=np.int64)
    bounds = np.searchsorted(minutes, starts)
    bounds = np.append(bounds, len(minutes))
    for k, (_, schedule, pct, shift) in enumerate(events):
        a, b = bounds[k], bounds[k + 1]
        if a >= b:
            continue
        local = ((minutes[a:b] + offsets[a:b] + shift * 60) % 1440) * 60
        j = np.searchsorted(schedule[:, 0], local, side='right') - 1
        rates[a:b] = schedule[np.clip(j, 0, None), 1] * pct / 100
    return rates


def basal_rates(minutes, profile, temps):
    """Delivered basal rate (U/h) for every minute: the profile rate, replaced
    by temp basals. A temp basal ends at its duration or at the next record."""
    rates = profile.copy()
    starts = to_minutes(temps['date'])
    durations = (temps['duration_ms'].to_numpy() / 60_000)
    rate = temps['rate'].to_numpy()
    percent = temps['percent'].to_numpy()
    first, last = minutes[0], minutes[-1]
    for k in range(len(temps)):
        d = durations[k]
        if not d > 0:
            continue  # cancels the previous temp basal: nothing to apply
        s = starts[k]
        e = s + int(round(d))
        if k + 1 < len(temps):
            e = min(e, starts[k + 1])
        if e <= first or s > last:
            continue
        a, b = max(s, first) - first, min(e, last + 1) - first
        if not np.isnan(rate[k]):
            rates[a:b] = rate[k]
        elif not np.isnan(percent[k]):
            rates[a:b] = profile[a:b] * max(0.0, 1 + percent[k] / 100)
    return rates


def _slot_sum(slot_index, values, n):
    out = np.zeros(n)
    np.add.at(out, slot_index, values)
    return out


def _slot_mean(slot_index, values, n):
    total = _slot_sum(slot_index, values, n)
    count = _slot_sum(slot_index, np.ones(len(values)), n)
    with np.errstate(invalid='ignore'):
        return np.where(count > 0, total / np.maximum(count, 1), np.nan)


def build_grid(data):
    g = data['glucose']
    first = to_minutes(g['date'][:1])[0] // SLOT_MIN * SLOT_MIN
    last = to_minutes(g['date'][-1:])[0] // SLOT_MIN * SLOT_MIN + SLOT_MIN
    minutes = np.arange(first, last, dtype=np.int64)
    slots = minutes[::SLOT_MIN]
    n = len(slots)

    def slot_of(dates):
        idx = (to_minutes(dates) - first) // SLOT_MIN
        return idx, (idx >= 0) & (idx < n)

    offsets = local_offsets(minutes, g)
    events = profile_events(data['profile_switches'], data['profile_stores'])
    profile = profile_rates(minutes, offsets, events)
    profile = np.where(np.isnan(profile), 0.0, profile)
    basal_min = basal_rates(minutes, profile, data['temp_basals']) / 60  # U per minute

    # Extended boluses: spread evenly over their duration (1-minute steps).
    extra_min = np.zeros(len(minutes))
    ext = data['extended']
    for start, units, dur in zip(to_minutes(ext['date']), ext['insulin'], ext['duration']):
        d = max(1, int(round(dur)))
        a, b = start - first, start - first + d
        if b <= 0 or a >= len(minutes):
            continue
        extra_min[max(a, 0):min(b, len(minutes))] += units / d

    idx, ok = slot_of(g['date'])
    glucose = _slot_mean(idx[ok], g['sgv'].to_numpy()[ok], n)
    b = data['boluses']
    idx, ok = slot_of(b['date'])
    bolus = _slot_sum(idx[ok], b['insulin'].to_numpy()[ok], n) + extra_min.reshape(n, SLOT_MIN).sum(axis=1)
    c = data['carbs']
    idx, ok = slot_of(c['date'])
    carbs = _slot_sum(idx[ok], c['carbs'].to_numpy()[ok], n)
    h = data['heartrate']
    idx, ok = slot_of(h['date'])
    hr = _slot_mean(idx[ok], h['bpm'].to_numpy()[ok], n)
    sport = _slot_sum(idx[ok], h['sport'].to_numpy()[ok].astype(float), n) > 0

    local_min = (slots + offsets[::SLOT_MIN]) % 1440
    return pd.DataFrame({
        'glucose': glucose,
        'bolus': bolus,
        'basal': basal_min.reshape(n, SLOT_MIN).sum(axis=1),
        'profile_basal': (profile / 60).reshape(n, SLOT_MIN).sum(axis=1),
        'carbs': carbs,
        'hr': hr,
        'sport': sport.astype(float),
        'local_hour': local_min / 60,
    }, index=pd.DatetimeIndex(slots * 60_000_000_000, tz='UTC', name='date'))
