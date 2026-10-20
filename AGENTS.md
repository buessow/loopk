# Repository Guidelines

## Project Structure & Module Organization

Loopk is a Nightscout-compatible CGM server backed by PostgreSQL. Server code
lives in `src/`: `api2/` and `api3/` implement HTTP compatibility layers,
`db/` maps documents to Postgres, `auth/` handles access, `sync/` handles
Nightscout following, and `web/` contains session routes. Browser assets are
plain ES modules, HTML, and CSS in `public/`. Add schema changes as the next
numbered SQL file in `migrations/`; do not alter applied migrations. Tests live
in `test/`, and operational scripts are in the repository root and `scripts/`.

## Build, Test, and Development Commands

- `npm install` installs the Node 20+ dependencies.
- `./setup-db-users.sh --local` creates local roles and writes connection URLs
  to `.env`; `./setup-databases.sh --target=local` creates databases and applies
  migrations.
- `npm run dev` starts the watcher with local authentication disabled.
- `npm start` runs the normal server using `.env` when present.
- `npm test` runs the complete Node test suite against `TEST_DATABASE_URL`.
- `npm run analyze:mongo` and `npm run migrate:mongo` inspect or import a
  Nightscout MongoDB source. Use `-- --dry-run` before an import.

## Coding Style & Naming Conventions

Use ESM (`import`/`export`), two-space indentation, semicolons, and the
existing `function name (` spacing. Keep modules focused and use lower-case,
hyphen-free file names matching their responsibility (for example,
`src/sync/normalize.js`). Prefer explicit, small helpers over opaque document
transformations. No formatter or lint command is configured; match nearby code
and run `node --check path/to/file.js` for edited JavaScript.

## Testing Guidelines

Tests use `node:test`, `node:assert/strict`, and `supertest`. Name files
`test/<area>.test.js` and tests as readable behavior statements, such as
`test('history returns changes after the cursor', ...)`. Cover API behavior and
database mappings for server changes; add focused model tests for browser-side
calculations. Run `npm test` before handing off a change.

## Forecast Models (`modelling/`)

Python with uv; run `uv run pytest -q tests` there. Score every forecast model
test (new inputs, training data, architecture, synthetic data) with the
standard benchmark: add the model to `CANDIDATES` in `modelling/benchmark.py`
and run `uv run python benchmark.py --candidates <name>`. It saves a scorecard
to `modelling/results/benchmark/<name>.json` and compares all saved runs in
`modelling/results/benchmark.md`, against "no change" and AAPS's curves. The
scorecard covers:

- accuracy at 15/30/60/120 min (MAE, RMSE, P90, bias, Clarke A, skill over
  "no change") on the slots where AAPS made a curve, all and "nothing eaten",
- by situation: actual < 70 / 70–180 / > 180, after a meal bolus or a
  correction, night, after sport, high heart rate,
- warnings of lows (< 70) within 15 and 30 min and highs (> 250) within 30
  min, per episode: a warning counts as correct if the event comes within the
  window plus 15 min (30 / 45 min); at the model's own threshold and at a fixed
  alarm budget,
- response to insulin (now, 1 h ago, meal bolus removed), carbs and exercise:
  direction and size against the measured effect,
- stability (5-minute revision of a forecast), 80% band coverage, and bias
  per half-year (drift).

Add targets for the problem a change is meant to solve (for example dosing
decisions, eat-now warnings, or a what-if line) as extra metrics in
`modelling/glupred/benchmark.py`, so they apply to later runs too. Report the
scorecard rows when presenting a model result. Results and models are derived
from health data: keep `modelling/results/` and `.cache/` out of git.

When presenting results, put one number per table cell, and before the
table explain every column in a short paragraph: what is counted, the
unit, and whether higher or lower is better. Never combine several numbers
in one cell (such as "98% / 54% / 35") without that explanation.

## Commit & Pull Request Guidelines

Use concise imperative, sentence-case commit subjects, following existing
history: `Add production deployment tooling` or `Improve chart loading and
mobile interactions`. Keep commits scoped. Pull requests should explain the
user-visible behavior, note migrations or configuration changes, list tests
run, and include screenshots for changes under `public/` that affect the UI.

## Security & Configuration

Never commit `.env`, database URLs, access tokens, OAuth credentials, or
production environment files. Use restricted database roles and keep
`--access-mode=restricted` for production-facing MCP or follow integrations.
