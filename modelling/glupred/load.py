"""Reads the raw series from the loopk database, cached as Parquet.

Each query result is cached in `.cache/<name>.parquet`. Pass `refresh=True`
(or `--refresh` on the command line) after importing new data.
"""

import os
from pathlib import Path

import pandas as pd
import psycopg

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).resolve().parents[1] / '.cache'

# Readings AAPS/Dexcom report outside the sensor range (LOW/HIGH) are clipped
# to these and carry no information about the actual value.
SGV_MIN, SGV_MAX = 40, 400

QUERIES = {
    # Sensor glucose (mg/dL) with the uploader's UTC offset (minutes).
    'glucose': f"""
        SELECT date, sgv, utc_offset FROM entries
         WHERE type = 'sgv' AND date IS NOT NULL AND sgv BETWEEN {SGV_MIN} AND {SGV_MAX}
         ORDER BY date""",

    # Boluses, including SMBs; priming is not delivered to the body. `smb`:
    # decided by AAPS. Marked as type SMB or is_smb, except from late 2023
    # to early 2025, when they came only as synced "Correction Bolus"
    # records (about 0.3 U, none near a marked SMB).
    'boluses': """
        SELECT date, insulin,
               type = 'SMB' OR coalesce(is_smb, false)
                 OR (entered_by = 'sync' AND event_type = 'Correction Bolus'
                     AND date >= '2023-10-01' AND date < '2025-04-01') AS smb
          FROM treatments
         WHERE insulin > 0 AND date IS NOT NULL
           AND coalesce(type, '') NOT IN ('PRIMING', 'FAKE_EXTENDED')
           AND coalesce(event_type, '') <> 'Combo Bolus'
         ORDER BY date""",

    # Extended boluses delivered on top of the basal. Those a FAKE_EXTENDED
    # temp basal emulates are already part of that temp basal's rate.
    'extended': """
        SELECT c.date, c.entered_insulin AS insulin, c.duration FROM treatments c
         WHERE c.event_type = 'Combo Bolus' AND c.entered_insulin > 0 AND c.duration > 0
           AND NOT coalesce(c.is_emulating_temp_basal, false)
           AND NOT EXISTS (SELECT 1 FROM treatments f
                            WHERE f.type = 'FAKE_EXTENDED'
                              AND f.extended_emulated->>'identifier' = c.identifier)
         ORDER BY c.date""",

    # Temp basals. `rate` is the absolute rate (U/h) also for percent temps;
    # a record without duration cancels the running temp basal.
    'temp_basals': """
        SELECT date, coalesce(duration_in_milliseconds, duration * 60000) AS duration_ms,
               coalesce(absolute, rate) AS rate, percent
          FROM treatments
         WHERE event_type = 'Temp Basal' AND date IS NOT NULL
         ORDER BY date""",

    'carbs': """
        SELECT date, carbs FROM treatments
         WHERE carbs > 0 AND date IS NOT NULL
         ORDER BY date""",

    # Profile switches; `schedule` is the embedded basal profile (unscaled)
    # as [[seconds, U/h], ...] when the switch carries one.
    'profile_switches': """
        SELECT t.date, t.profile, coalesce(t.percentage, 100) AS percentage,
               coalesce(t.timeshift, 0) AS timeshift, coalesce(t.duration, 0) AS duration,
               (SELECT json_agg(json_build_array(coalesce(s.seconds, extract(epoch FROM s.time::time)::int), s.value) ORDER BY s.position)
                  FROM treatment_profile_schedules s
                 WHERE s.treatment_identifier = t.identifier AND s.kind = 'basal') AS schedule
          FROM treatments t
         WHERE t.event_type = 'Profile Switch' AND t.date IS NOT NULL
         ORDER BY t.date""",

    # Basal schedules of every stored profile document.
    'profile_stores': """
        SELECT p.date, p.default_profile, s.name,
               json_agg(json_build_array(coalesce(s.seconds, extract(epoch FROM s.time::time)::int), s.value) ORDER BY s.position) AS schedule
          FROM profile p JOIN profile_store_schedules s ON s.profile_identifier = p.identifier
         WHERE s.kind = 'basal' AND p.date IS NOT NULL
         GROUP BY p.identifier, p.date, p.default_profile, s.name
         ORDER BY p.date""",

    'heartrate': """
        -- Garmin uploads from a data field (device ending in _DF) are
        -- recorded during an activity; watch face and widget ones are not.
        SELECT date, beats_per_minute AS bpm, duration AS duration_ms,
               coalesce(right(device, 3) = '_DF', false) AS sport
          FROM heartrate
         WHERE date IS NOT NULL AND beats_per_minute BETWEEN 25 AND 250
         ORDER BY date""",

    # AAPS's own predictions (mg/dL, 5-minute steps from `date`).
    'aaps_predictions': """
        SELECT d.date, d.suggested_bg AS bg, d.suggested_cob AS cob, p.curve, p."values"
          FROM devicestatus_predictions p
          JOIN devicestatus d ON d.identifier = p.devicestatus_identifier
         WHERE p.source = 'suggested' AND d.date IS NOT NULL
         ORDER BY d.date""",
    # The values AAPS based each decision on, from its reason text (in the
    # user's units). "minGuardBG x<y" is logged when it suspends (LGS).
    'aaps_decisions': r"""
        SELECT date, suggested_bg AS bg, suggested_eventual_bg AS eventual_bg,
               substring(suggested_reason FROM 'Target: (-?[0-9.]+)')::float AS target,
               substring(suggested_reason FROM 'ISF: (-?[0-9.]+)')::float AS isf,
               substring(suggested_reason FROM 'CR: (-?[0-9.]+)')::float AS cr,
               substring(suggested_reason FROM 'minPredBG (-?[0-9.]+)')::float AS min_pred,
               substring(suggested_reason FROM 'minGuardBG (-?[0-9.]+),')::float AS min_guard,
               substring(suggested_reason FROM 'minGuardBG -?[0-9.]+ ?< ?(-?[0-9.]+)')::float AS lgs_threshold
          FROM devicestatus
         WHERE suggested_reason IS NOT NULL AND date IS NOT NULL
         ORDER BY date""",
}


def database_url():
    url = os.environ.get('DATABASE_URL')
    if url:
        return url
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text().splitlines():
            key, _, value = line.partition('=')
            if key.strip() == 'DATABASE_URL':
                return value.strip().strip('"\'')
    raise RuntimeError('DATABASE_URL is not set and not in ../.env')


def load(name, refresh=False):
    """The result of query `name` as a DataFrame with a UTC `date` column."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f'{name}.parquet'
    if path.exists() and not refresh:
        return pd.read_parquet(path)
    with psycopg.connect(database_url()) as conn, conn.cursor() as cur:
        cur.execute(QUERIES[name])
        columns = [c.name for c in cur.description]
        df = pd.DataFrame(cur.fetchall(), columns=columns)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    for col in df.columns:
        if df[col].dtype == object and col not in ('profile', 'name', 'default_profile', 'curve', 'schedule', 'values'):
            df[col] = pd.to_numeric(df[col])
    if 'schedule' in df:
        df['schedule'] = df['schedule'].map(lambda s: None if s is None else [[int(a), float(b)] for a, b in s])
    df.to_parquet(path)
    return df


def load_all(refresh=False):
    return {name: load(name, refresh) for name in QUERIES}
