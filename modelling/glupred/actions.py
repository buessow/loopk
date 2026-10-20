"""Insulin and carb action curves as per-slot kernels.

kernel[j] is the fraction of a dose given at the start of slot 0 that acts
(insulin) or is absorbed (carbs) during slot j.
"""

import math

import numpy as np


def exponential_insulin_iob(t, peak=55.0, duration=360.0):
    """Insulin on board (fraction) t minutes after a dose, for the
    exponential model (https://seemycgm.com/2017/10/21/exponential-insulin-curves-fiasp/)."""
    tp, td = peak, duration
    tau = tp * (1 - tp / td) / (1 - 2 * tp / td)
    a = 2 * tau / td
    s = 1 / (1 - a + (1 + a) * math.exp(-td / tau))
    t = np.asarray(t, dtype=np.float64)
    iob = 1 - s * (1 - a) * ((t * t / (tau * td * (1 - a)) - t / tau - 1) * np.exp(-t / tau) + 1)
    return np.where(t < 0, 1.0, np.where(t > td, 0.0, iob))


def insulin_kernel(slot_min=5, peak=55.0, duration=360.0):
    edges = np.arange(0, duration + slot_min, slot_min)
    iob = exponential_insulin_iob(edges, peak, duration)
    return iob[:-1] - iob[1:]


def lognormal_cdf(t_h, mu, sigma):
    t_h = np.asarray(t_h, dtype=np.float64)
    with np.errstate(divide='ignore'):
        z = (np.log(np.maximum(t_h, 1e-12)) - mu) / (sigma * math.sqrt(2))
    return np.where(t_h <= 0, 0.0, 0.5 * (1 + np.vectorize(math.erf)(z)))


def carb_kernel(slot_min=5, peak=45.0, sigma=0.5, duration=240.0):
    """Log-normal absorption with its mode at `peak` minutes, renormalized to
    sum to 1 over `duration`."""
    mu = math.log(peak / 60) + sigma * sigma
    edges = np.arange(0, duration + slot_min, slot_min) / 60
    cdf = lognormal_cdf(edges, mu, sigma)
    k = cdf[1:] - cdf[:-1]
    return k / k.sum()


def remaining(kernel):
    """remaining[j]: fraction still to act after slot j (on board at its end)."""
    return 1 - np.cumsum(kernel)
