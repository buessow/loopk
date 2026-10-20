# Glucose prediction modelling

Offline training and evaluation of glucose prediction from the loopk
database; findings in `FINDINGS.md`. Nothing here runs in the server: the
server's 15/30-minute model (`src/predict/`) is trained and exported by
`export.py`.

```sh
cd modelling
uv sync
uv run python train.py --refresh          # reload from DATABASE_URL (../.env), then train
uv run python train.py --models ridge     # reuse the cached data
uv run python train.py --oracle           # also measure the future-inputs leak
uv run python scenarios.py               # 4 h model: dosing, eat-now, highs
uv run python whatif.py                  # forecasts under an insulin plan
uv run python export.py                  # retrain and export the server model
uv run python upload.py --url https://loopk.robertbuessow.com --token <token>   # upload results/model.json
uv run pytest
```

- `glupred/load.py` — SQL for the raw series, cached as Parquet in `.cache/`.
- `glupred/grid.py` — 5-minute grid: glucose, bolus and basal insulin
  (profile + temp basals, integrated per minute), carbs, heart rate, local hour.
- `glupred/actions.py` — exponential insulin and log-normal carb curves.
- `glupred/features.py` — feature matrix and targets. Inputs use only data up
  to the prediction time; insulin and carbs enter as the activity of doses
  already given.
- `glupred/baselines.py`, `glupred/metrics.py` — persistence, linear trend,
  AAPS's own predicted curves; MAE/RMSE, Clarke zones, low detection.
- `train.py` — time-based split (train → 2025-01, validation → 2025-07, test
  after), writes `results/report.md` (not committed: derived from health data).
- `scenarios.py`, `whatif.py` — scenario and what-if reports in `results/`.
- `export.py` — trains the server model, writes `results/model.json` (not
  committed) and the parity fixture `../test/fixtures/prediction.json`
  (synthetic readings, random network). `--upload [URL]` also uploads it.
- `upload.py` — uploads a model file (default `results/model.json`) to a
  loopk server. `--url` and `--token`, or `LOOPK_URL` and
  `LOOPK_MODEL_TOKEN`; the token is an "Upload model" access token from the
  server's Access page. The server reruns the model's bundled checks before
  it accepts it.
