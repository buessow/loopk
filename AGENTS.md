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
