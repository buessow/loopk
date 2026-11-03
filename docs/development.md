# Developing Loopk

How the parts that run without the full server work, and how to test
them. Running the server itself is in [full-server.md](full-server.md),
the two modes in [modes.md](modes.md); conventions for changes are in
`AGENTS.md`.

## Over a Nightscout server

The browser's worker and an agent's own MCP (below) read a Nightscout server, or a Loopk, through API v3 into an in-memory Postgres (PGlite) and answer with the same queries as the server (`src/data/nightscout/`). They load what each read needs: the time ranges it reads, and profile switches back from a time until the one in effect; a longer period fetches only the days missing. Changes on that server are read at most once a minute. Sport mode and copying a profile write to that server. Two lookups are narrower than with Postgres: limits named in the loop's reasons come from the last 2 days (not 90), and the simulator lists the profiles switched to in the last 60 days (not a year). An agent reading Nightscout keeps the loop settings and the AI Test profile there, as documents `loopk-loop-settings` and `loopk-test-profiles` of its settings collection (saving them needs a token that may change settings there). The server itself always keeps its data in Postgres; `docs/modes.md` describes the static pages that run without it.

## In the browser

The simulator always runs in the browser (agents simulate through MCP, on the server or in their own Node, below): `public/localworker.js` runs the server's own Nightscout source over PGlite in a Web Worker and answers the simulator's requests there (`public/localapi.js` over `src/oref/api.js`). The server serves the browser-safe parts of `src/`, `/migrations.json` and PGlite under `/vendor/pglite/`, and keeps what is saved: `GET /api/simulate/stored` hands the worker the loop settings entered and the AI Test profile, and saving settings and the AI Test profile's routes stay on the server. Pages call `request()` (`public/local.js`) instead of `fetch()`:

- Signed in to Loopk, the worker reads Loopk's own API v3 with the page's session, so the data comes from Loopk's server as for the other pages.
- While a tab holds a Nightscout address and token (opened from `/direct-test`), the worker reads that server directly and answers the rest of Loopk's API too, so no data goes through Loopk's server. The Nightscout server needs CORS (`ENABLE` with `cors`).

Keep modules under `src/analysis`, `data`, `oref`, `predict` and `sync` free of Node imports at load time.

## Agents in their own Node

The Access page offers agents loopk's MCP two ways: the endpoint on this server (`/mcp?token=`), or the same tools run by the agent itself, as a stdio MCP server in Node 20+ on its machine: `npx -y <loopk>/mcp/local.tgz` with `LOOPK_URL` and `LOOPK_TOKEN` (a read token is enough). `src/mcp/local.js` reads the data with the token into an in-memory Postgres, as the browser does, and answers every tool and simulation there; the server only sends the data and the code. The AI Test profile it writes is saved on the server (`PUT /api/simulate/test-profile`). With `NIGHTSCOUT_URL` and `NIGHTSCOUT_TOKEN` instead, it reads a Nightscout server directly and keeps loopk's settings there (saving needs a token that may change settings); `TZ_NAME` sets the person's time zone.

`src/mcp/pack.js` builds the package in memory from what `local.js` imports, the migrations and the AAPS guide, with the packages they import at the server's versions. npx keeps a package it fetched from a URL, so `/mcp/local.json` names the current version's URL; any version's URL serves the current package, and an agent gets an update by being added again.

## A test Nightscout

`scripts/nightscout-test.sh start` runs a real Nightscout (release v15.0.9, from source) on this machine for testing Loopk against: its own MongoDB on port 27018, Nightscout at http://localhost:1340 with CORS on (`ENABLE` with `cors`, any origin, as a browser reading Nightscout directly needs). The first start installs it into `.cache/` and writes its API secret and two access tokens, `loopk-read` (readable) and `loopk-admin` (admin), to `.cache/nightscout.env`; `stop` stops it. It starts empty: `SOURCE_URL=… SOURCE_TOKEN=… node scripts/nightscout-seed.js 30` copies the last 30 days of another server into it through API v3. That is health data, so keep it on this machine; `.cache/` is not in git. For data that is nobody's, `node scripts/nightscout-fake.js 14 --replace` makes up 14 days instead (a profile, CGM, meals, walks and a simple SMB loop with its device status) and replaces what the test Nightscout holds; `--dry-run` only prints a summary, and `SEED` picks another set.

Nightscout differs from a Loopk upstream: it has no heart rate collection (Loopk reads none from it), and only admin tokens may read its settings collection.

## Tests

`npm test` runs against `TEST_DATABASE_URL` (the `loopk_test` database); with `TEST_DATA_SOURCE=memory` it runs against an in-memory database instead, which needs no Postgres.
