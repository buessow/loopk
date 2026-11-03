# Developing Loopk

How the parts that run without the full server work, and how to test
them. Running the server itself is in [full-server.md](full-server.md),
the two modes in [modes.md](modes.md); conventions for changes are in
`AGENTS.md`.

## Over a Nightscout server

The browser's worker and an agent's own MCP (below) read a Nightscout server, or a Loopk, through API v3 into an in-memory Postgres (PGlite) and answer with the same queries as the server (`src/data/nightscout/`). They load what each read needs: the time ranges it reads, and profile switches back from a time until the one in effect; a longer period fetches only the days missing. Changes on that server are read at most once a minute. Sport mode and copying a profile write to that server. Two lookups are narrower than with Postgres: limits named in the loop's reasons come from the last 2 days (not 90), and the simulator lists the profiles switched to in the last 60 days (not a year). Loopk's own settings (the loop settings entered, the AI Test profile, sport mode) are one document the caller keeps (`src/data/nightscout/settings.js`): the browser in `localStorage`, an agent in a file; nothing goes to Nightscout's settings collection. A source can start from a cache kept from before (`kept`, `onChange`), reading only what changed since. The server itself always keeps its data in Postgres; `docs/modes.md` describes the static pages that run without it.

## In the browser

The simulator always runs in the browser (agents simulate through MCP, on the server or in their own Node, below): `public/localworker.js` runs the server's own Nightscout source over PGlite in a Web Worker and answers the simulator's requests there (`public/localapi.js` over `src/oref/api.js`). The server serves the browser-safe parts of `src/`, `/migrations.json` and PGlite under `/vendor/pglite/`, and keeps what is saved: `GET /api/simulate/stored` hands the worker the loop settings entered and the AI Test profile, and saving settings and the AI Test profile's routes stay on the server. Pages call `request()` (`public/local.js`) instead of `fetch()`:

- Signed in to Loopk, the worker reads Loopk's own API v3 with the page's session, so the data comes from Loopk's server as for the other pages.
- While a tab holds a Nightscout address and token (the static server's sign-in, or `/direct-test` on the full server), the worker reads that server directly and answers all of Loopk's API (`public/localapi.js`: reports, misses, profiles, sport mode, the simulator and loopk's settings), so no data goes through Loopk's server. The Nightscout server needs CORS (`ENABLE` with `cors`). Its database is kept in IndexedDB (`docs/modes.md`, Caching).

Keep the parts of `src/` in `BROWSER_SOURCE` (`src/app.js`) free of Node imports at load time; a module that needs one only on the server loads it there (`import()`), as sport mode does for `uuid`.

### The static pages, locally

`node scripts/build-static.js <dir> --pages` writes the static server. Serve it as GitHub Pages does (`/simulate` is `simulate.html`; MIME types for `.js` and `.wasm`) on `localhost`, which browsers treat as secure, and sign in with the test Nightscout below. Its service worker keeps the code of the version first loaded until every page of it is closed: after a new build, close the tabs (or use a new browser profile).

## Agents in their own Node

The Access page offers agents loopk's MCP two ways: the endpoint on this server (`/mcp?token=`), or the same tools run by the agent itself, as a stdio MCP server in Node 20+ on its machine: `npx -y <loopk>/mcp/local.tgz` with `LOOPK_URL` and `LOOPK_TOKEN` (a read token is enough). `src/mcp/local.js` reads the data with the token into an in-memory Postgres, as the browser does, and answers every tool and simulation there; the server only sends the data and the code. The AI Test profile it writes is saved on the server (`PUT /api/simulate/test-profile`). With `NIGHTSCOUT_URL` and `NIGHTSCOUT_TOKEN` instead, it reads a Nightscout server directly and keeps loopk's settings in the JSON file `LOOPK_SETTINGS` (default `~/.config/loopk/settings.json`), the file the browser's "Export settings" writes; `TZ_NAME` sets the person's time zone.

`src/mcp/pack.js` builds the package in memory from what `local.js` imports, the migrations and the AAPS guide, with the packages they import at the server's versions, and names it by the hash of its tar. npx keeps a package it fetched from a URL, so `/mcp/local.tgz` is a small package that never changes (`src/mcp/latest.js`): at each start it runs the version `/mcp/local.json` names.

## A test Nightscout

`scripts/nightscout-test.sh start` runs a real Nightscout (release v15.0.9, from source) on this machine for testing Loopk against: its own MongoDB on port 27018, Nightscout at http://localhost:1340 with CORS on (`ENABLE` with `cors`, any origin, as a browser reading Nightscout directly needs). The first start installs it into `.cache/` and writes its API secret and two access tokens, `loopk-read` (readable) and `loopk-admin` (admin), to `.cache/nightscout.env`; `stop` stops it. It starts empty: `SOURCE_URL=… SOURCE_TOKEN=… node scripts/nightscout-seed.js 30` copies the last 30 days of another server into it through API v3. That is health data, so keep it on this machine; `.cache/` is not in git. For data that is nobody's, `node scripts/nightscout-fake.js 14 --replace` makes up 14 days instead (a profile, CGM, meals, walks and a simple SMB loop with its device status) and replaces what the test Nightscout holds; `--dry-run` only prints a summary, and `SEED` picks another set.

Nightscout differs from a Loopk upstream: it has no heart rate collection (Loopk reads none from it).

## Tests

`npm test` runs against `TEST_DATABASE_URL` (the `loopk_test` database); with `TEST_DATA_SOURCE=memory` it runs against an in-memory database instead, which needs no Postgres.
