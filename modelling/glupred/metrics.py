"""Accuracy measures for predicted vs. actual glucose (mg/dL)."""

import numpy as np


def clarke_zone(ref, pred):
    """Clarke error grid zone ('A'..'E') for each pair (Clarke et al. 1987)."""
    ref = np.asarray(ref, dtype=np.float64)
    pred = np.asarray(pred, dtype=np.float64)
    zone = np.full(ref.shape, 'B', dtype='<U1')
    a = ((ref <= 70) & (pred <= 70)) | (np.abs(pred - ref) <= 0.2 * ref)
    e = ((ref >= 180) & (pred <= 70)) | ((ref <= 70) & (pred >= 180))
    c = (((ref >= 70) & (ref <= 290)) & (pred >= ref + 110)) | \
        (((ref >= 130) & (ref <= 180)) & (pred <= (7 / 5) * ref - 182))
    d = ((ref >= 240) & (pred >= 70) & (pred <= 180)) | \
        ((ref <= 175 / 3) & (pred <= 180) & (pred >= 70)) | \
        ((ref >= 175 / 3) & (ref <= 70) & (pred >= (6 / 5) * ref))
    zone[d] = 'D'
    zone[c] = 'C'
    zone[e] = 'E'
    zone[a] = 'A'
    return zone


def horizon_errors(actual, predicted):
    """MAE and RMSE per horizon column; arrays of shape (n, horizons)."""
    err = predicted - actual
    return np.mean(np.abs(err), axis=0), np.sqrt(np.mean(err ** 2, axis=0))


def low_detection(actual, predicted, threshold=70):
    """Recall and precision of predicting glucose below `threshold`."""
    is_low = actual < threshold
    said_low = predicted < threshold
    tp = np.sum(is_low & said_low)
    recall = tp / max(1, np.sum(is_low))
    precision = tp / max(1, np.sum(said_low))
    return recall, precision, int(np.sum(is_low))


def summarize(name, actual, predicted, minutes=(15, 30, 45, 60), zone_minutes=(30, 60)):
    """One row of headline numbers; actual/predicted are (n, 12) absolute mg/dL."""
    mae, rmse = horizon_errors(actual, predicted)
    row = {'model': name, 'n': len(actual)}
    p90 = np.percentile(np.abs(predicted - actual), 90, axis=0)
    mard = 100 * np.mean(np.abs(predicted - actual) / actual, axis=0)
    for m in minutes:
        h = m // 5 - 1
        row[f'MAE{m}'] = mae[h]
        row[f'P90_{m}'] = p90[h]
        row[f'RMSE{m}'] = rmse[h]
        row[f'MARD{m}%'] = mard[h]
    for m in zone_minutes:
        h = m // 5 - 1
        zones = clarke_zone(actual[:, h], predicted[:, h])
        row[f'A{m}%'] = 100 * np.mean(zones == 'A')
        row[f'D+E{m}%'] = 100 * np.mean((zones == 'D') | (zones == 'E'))
        recall, precision, _ = low_detection(actual[:, h], predicted[:, h])
        row[f'low{m} recall%'] = 100 * recall
        row[f'low{m} prec%'] = 100 * precision
    return row


RANGES = [(0, 54, '<54'), (54, 70, '54-70'), (70, 180, '70-180'), (180, 250, '180-250'), (250, 1000, '>250')]


def by_range(name, actual, predicted, minutes):
    """Rows of errors per range of the actual glucose `minutes` ahead."""
    h = minutes // 5 - 1
    a, p = actual[:, h], predicted[:, h]
    zones = clarke_zone(a, p)
    rows = []
    for lo, hi, label in RANGES:
        m = (a >= lo) & (a < hi)
        if not m.any():
            continue
        err = p[m] - a[m]
        rows.append({
            'model': name, 'range': label, 'share%': 100 * m.mean(),
            'MAE': np.mean(np.abs(err)), 'P90': np.percentile(np.abs(err), 90),
            'bias': np.mean(err), 'MARD%': 100 * np.mean(np.abs(err) / a[m]),
            'A%': 100 * np.mean(zones[m] == 'A'), 'D+E%': 100 * np.mean(np.isin(zones[m], ['D', 'E'])),
            'pred<70%': 100 * np.mean(p[m] < 70),
        })
    return rows


def low_warnings(name, actual, predicted, minutes, thresholds=(70, 80, 90)):
    """Recall/precision of warning when the prediction is below a threshold."""
    h = minutes // 5 - 1
    low = actual[:, h] < 70
    row = {'model': name}
    for th in thresholds:
        said = predicted[:, h] < th
        tp = np.sum(said & low)
        row[f'<{th} recall%'] = 100 * tp / max(1, low.sum())
        row[f'<{th} prec%'] = 100 * tp / max(1, said.sum())
    return row
