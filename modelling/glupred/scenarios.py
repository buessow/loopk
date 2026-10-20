"""The two uses of a prediction, scored the way they are used.

Dosing (AAPS-style): suspend insulin when glucose is predicted to go below
the target's lower end within the hour. A missed event means insulin is
delivered that cannot be taken back; an unnecessary suspension is cheap
because delivery resumes. Scored by the unnecessary suspensions needed to
catch a given share of events.

Eat-now warning: warn when glucose is about to fall below LOW. Missed lows
and false alarms both matter. Scored per low (announced in advance? how many
minutes ahead?) and per alarm (one alarm per run of warnings).
"""

import numpy as np

from .features import LOW, rolling, shift

TARGET_LOW = 99      # mg/dL, 5.5 mmol/L
DOSING_WINDOWS = (12, 24, 36, 48)  # 1, 2, 3, 4 h
WARNING_SLOTS = 6    # 30 min
MIN_LEAD = 15        # minutes a warning needs to be useful
ALARM_GAP = 3        # warnings less than 15 min apart are one alarm


def dosing_event(actual, slots):
    return np.min(actual[:, :slots], axis=1) < TARGET_LOW


def low_event(actual, g_now):
    return (np.min(actual[:, :WARNING_SLOTS], axis=1) < LOW) & (g_now >= LOW)


def threshold_for_recall(score, event, recall):
    """Smallest score threshold that flags `recall` of the events."""
    return np.quantile(score[event], 1 - recall)


def dosing_row(name, score, event, actual, threshold, target, slots):
    suspend = score >= threshold
    missed = event & ~suspend
    deep = np.min(actual[:, :slots], axis=1) < LOW
    return {
        'window': f'{slots // 12} h', 'model': name, 'target recall': f'{100 * target:.0f}%',
        'events caught %': 100 * np.mean(suspend[event]),
        'suspended, % of time': 100 * np.mean(suspend),
        'unnecessary: % of no-event time suspended': 100 * np.mean(suspend[~event]),
        'missed events going < 70 %': 100 * np.sum(missed & deep) / max(1, np.sum(event & deep)),
    }


def high_event(actual, g_now, level, slots):
    return (np.max(actual[:, :slots], axis=1) > level) & (g_now <= level)


def crossings(glucose, level=LOW, rising=False):
    """Slots where glucose falls below `level` (or rises above it) after
    30 min on the other side."""
    beyond = glucose > level if rising else glucose < level
    before = (~beyond & ~np.isnan(glucose)).astype(float)
    return np.where(beyond & (shift(rolling(before, 6, 'sum'), 1) == 6))[0]


def warning_episodes(warn, lows, weeks, slots=WARNING_SLOTS):
    """Per-event and per-alarm scores for a warning flag on every grid slot.
    `lows` are the event slots (crossings); a warning counts for an event in
    the `slots` slots before it."""
    n = len(warn)
    announced, leads = 0, []
    for c in lows:
        w = np.where(warn[max(0, c - slots):c])[0]
        if len(w):
            announced += 1
            leads.append(5 * (min(slots, c) - w[0]))
    early = sum(lead >= MIN_LEAD for lead in leads)
    idx = np.where(warn)[0]
    starts = idx[np.concatenate([[True], np.diff(idx) > ALARM_GAP])] if len(idx) else idx
    ends = idx[np.concatenate([np.diff(idx) > ALARM_GAP, [True]])] if len(idx) else idx
    is_low = np.zeros(n + slots + 1, dtype=bool)
    is_low[lows] = True
    cum = np.concatenate([[0], np.cumsum(is_low)])
    true_alarms = sum(cum[min(len(cum) - 1, e + slots + 1)] - cum[s + 1] > 0 for s, e in zip(starts, ends))
    alarms = len(starts)
    recall = announced / max(1, len(lows))
    precision = true_alarms / max(1, alarms)
    return {
        'announced %': 100 * recall,
        f'announced ≥ {MIN_LEAD} min ahead %': 100 * early / max(1, len(lows)),
        'median minutes ahead': float(np.median(leads)) if leads else np.nan,
        'alarms per week': alarms / weeks,
        'false alarms per week': (alarms - true_alarms) / weeks,
        'alarms followed by the event %': 100 * precision,
        'F1': 2 * recall * precision / max(1e-9, recall + precision),
    }


# --- AAPS's own decisions. Its guard curves run up to 4 h; eventualBG is
# roughly where glucose settles once current insulin and carbs have acted.
GUARD_SLOTS = 48
EVENTUAL_SLOTS = (36, 48)  # 3–4 h
LEAD_SLOTS = 12            # suspending in the hour before a low


def guard_event(actual, g_now):
    """Glucose falls below LOW within GUARD_SLOTS, from at or above it."""
    return (np.min(actual[:, :GUARD_SLOTS], axis=1) < LOW) & (g_now >= LOW)


def eventual_event(actual):
    """Mean glucose 3–4 h ahead is below the target's lower end."""
    a, b = EVENTUAL_SLOTS
    return np.mean(actual[:, a:b], axis=1) < TARGET_LOW


def decision_row(name, flag, event, flag_all, lows, carbs_within=None):
    """A yes/no decision per sample (`flag`, with `event` the outcome it is
    meant for), and per low: was it on for half of the hour before?
    `flag_all` is the same decision on the full grid, `lows` crossing slots.
    `carbs_within` ({label: bool per sample}) also counts a decision as
    justified when carbs (logged or assumed) follow, since eating may have
    been what kept glucose up."""
    before = np.array([np.mean(flag_all[c - LEAD_SLOTS:c]) for c in lows if c >= LEAD_SLOTS])
    row = {
        'model': name,
        'on, % of time': 100 * np.mean(flag),
        'events caught %': 100 * np.mean(flag[event]),
        'on without event, % of no-event time': 100 * np.mean(flag[~event]),
        'followed by the event %': 100 * np.mean(event[flag]) if flag.any() else np.nan,
    }
    for label, carbs in (carbs_within or {}).items():
        row[f'followed by the event or carbs within {label} %'] = (
            100 * np.mean((event | carbs)[flag]) if flag.any() else np.nan)
    row['lows with ≥ 30 of 60 min before on %'] = 100 * np.mean(before >= 0.5) if len(before) else np.nan
    return row
