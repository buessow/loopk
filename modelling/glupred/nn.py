"""Multi-output MLP: expected glucose, low quantiles, and event probabilities.

Outputs per sample:
- `mean`: log(g[i+h] / g[i]) for each horizon (squared error),
- `q<p>`: the p-quantile of the same (pinball loss), e.g. q0.1,
- one probability per event column (binary cross-entropy).

Regression targets count only where `mask` is set (no new carbs before that
horizon), so the glucose outputs predict what happens if nothing is eaten.
"""

import numpy as np
import torch
from torch import nn


class Net(nn.Module):
    def __init__(self, n_in, horizons, quantiles, events, hidden=(128, 64)):
        super().__init__()
        layers, d = [], n_in
        for h in hidden:
            layers += [nn.Linear(d, h), nn.ReLU()]
            d = h
        self.trunk = nn.Sequential(*layers)
        self.horizons = horizons
        self.quantiles = list(quantiles)
        self.events = list(events)
        self.head = nn.Linear(d, horizons * (1 + len(self.quantiles)) + len(self.events))

    def forward(self, x):
        out = self.head(self.trunk(x))
        k = self.horizons * (1 + len(self.quantiles))
        reg = out[:, :k].reshape(-1, 1 + len(self.quantiles), self.horizons)
        return reg, out[:, k:]


def _loss(net, reg, logits, y, mask, ev):
    m = mask.float()
    count = m.sum().clamp(min=1)
    loss = (((reg[:, 0] - y) ** 2) * m).sum() / count
    for j, q in enumerate(net.quantiles, start=1):
        e = y - reg[:, j]
        loss = loss + (torch.maximum(q * e, (q - 1) * e) * m).sum() / count
    if net.events:
        loss = loss + nn.functional.binary_cross_entropy_with_logits(logits, ev)
    return loss


class Model:
    """Standardizes inputs and targets, trains with early stopping."""

    def __init__(self, quantiles=(0.1, 0.25), events=(), hidden=(128, 64), seed=1):
        self.quantiles = quantiles
        self.events = events
        self.hidden = hidden
        self.seed = seed

    def fit(self, X, g_now, Y, mask, E, X_val, g_val, Y_val, mask_val, E_val,
            epochs=40, patience=4, batch=1024, lr=1e-3, log=print):
        torch.manual_seed(self.seed)
        self.mu = X.mean(axis=0)
        self.sd = X.std(axis=0) + 1e-9
        target = np.log((Y + g_now[:, None]) / g_now[:, None])
        self.ysd = target.std(axis=0)
        t = self._tensors(X, g_now, Y, mask, E)
        v = self._tensors(X_val, g_val, Y_val, mask_val, E_val)
        self.net = Net(X.shape[1], Y.shape[1], self.quantiles, self.events, self.hidden)
        opt = torch.optim.Adam(self.net.parameters(), lr=lr)
        best, best_state, bad = np.inf, None, 0
        n = len(X)
        for epoch in range(epochs):
            self.net.train()
            perm = torch.randperm(n)
            for s in range(0, n, batch):
                i = perm[s:s + batch]
                reg, logits = self.net(t[0][i])
                loss = _loss(self.net, reg, logits, t[1][i], t[2][i], t[3][i])
                opt.zero_grad()
                loss.backward()
                opt.step()
            self.net.eval()
            with torch.no_grad():
                reg, logits = self.net(v[0])
                val = _loss(self.net, reg, logits, *v[1:]).item()
            log(f'    epoch {epoch + 1}: validation loss {val:.4f}')
            if val < best - 1e-5:
                best, bad = val, 0
                best_state = {k: p.clone() for k, p in self.net.state_dict().items()}
            else:
                bad += 1
                if bad >= patience:
                    break
        self.net.load_state_dict(best_state)
        return self

    def _tensors(self, X, g_now, Y, mask, E):
        x = torch.tensor((X - self.mu) / self.sd, dtype=torch.float32)
        y = torch.tensor(np.log((Y + g_now[:, None]) / g_now[:, None]) / self.ysd, dtype=torch.float32)
        e = torch.tensor(np.zeros((len(X), 0)) if E is None else E, dtype=torch.float32)
        return x, y, torch.tensor(mask), e

    def predict(self, X, g_now):
        """{'mean': glucose (n, h), 'q0.1': ..., event: probability (n,)}"""
        self.net.eval()
        with torch.no_grad():
            reg, logits = self.net(torch.tensor((X - self.mu) / self.sd, dtype=torch.float32))
        reg = reg.numpy() * self.ysd
        out = {'mean': g_now[:, None] * np.exp(reg[:, 0])}
        for j, q in enumerate(self.quantiles, start=1):
            out[f'q{q}'] = g_now[:, None] * np.exp(reg[:, j])
        for j, name in enumerate(self.events):
            out[name] = torch.sigmoid(logits[:, j]).numpy()
        return out
