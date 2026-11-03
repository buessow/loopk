# Modes: full server and static server

loopk runs in one of two modes. They share the same code. What differs is
where that code runs, and where the data and the access token go.

- **Full server**: loopk is a server with its own Postgres database. AAPS
  uploads to it, it follows a Nightscout server, and its routes answer the
  pages and the agents. This is loopk as it is deployed today.
- **Static server**: loopk is only files: HTML, JS, CSS and the MCP
  package, served by any static host, such as GitHub Pages. Everything runs
  in the browser or in the agent's own Node. The data comes straight from
  the person's Nightscout server, and no loopk server ever sees the data or
  the token.

The static server exists for people whose data loopk should never hold:
loopk can serve them without being a medical data processor, because it
has no server that could receive the data.

## Full server

```
AAPS ──API v3──▶ loopk server ──▶ Postgres
                    ▲   ▲
     pages (session)┘   └ agents (/mcp?token=, or their own MCP with LOOPK_URL)
```

- **Storage.** The data is kept in Postgres: `src/data/postgres/`, with the
  migrations in `migrations/`. AAPS uploads through API v3. Following
  (`FOLLOW_URL`) mirrors a Nightscout server while someone moves over.
- **Sign-in.** People sign in with Google. Access tokens for AAPS, API
  clients and agents are made on the Access page.
- **Pages.** Pages read through the server's routes. The simulator already
  runs in the browser: `public/localworker.js` reads loopk's API v3 with the
  session and computes there. Saving still goes through the server.
- **Agents.** An agent can do either:
  - use the endpoint `/mcp?token=`, where tools and simulations run on the
    server;
  - run `src/mcp/local.js` itself with `LOOPK_URL` and `LOOPK_TOKEN`. It
    reads the data from loopk's API v3 and computes in its own Node. The AI
    Test profile is still saved on the server.
- **Server-only features.** These need the server:
  - Google sign-in, people and tokens;
  - following;
  - live updates over Socket.IO;
  - report dashboards kept per person;
  - the prediction model uploaded to the server (`src/predict/store.js`).

The full server always has Postgres. The server variant over a Nightscout
server was removed: `DATA_SOURCE=nightscout`, with or without
`NIGHTSCOUT_TOKEN`, together with `src/passthrough/`. Such a server keeps
nothing, but every request and all the data still pass through it, and the
static server covers that need without a server. The Nightscout data source
(`src/data/nightscout/`) stays, because the browser's worker and the
agent's MCP run it.

## Static server

```
static host (GitHub Pages) ──code only──▶ browser ──API v3 + CORS──▶ Nightscout
                           ──mcp package─▶ agent's Node ──API v3──▶ Nightscout
```

### What is published

The static server publishes only files, and nothing personal: no data, no
token, no model derived from someone's data. A build step writes it into a
directory, and a GitHub Actions workflow publishes that directory to
GitHub Pages:

- `public/`, the pages;
- the browser-safe parts of `src/` (`BROWSER_SOURCE` in `src/app.js`:
  `analysis`, `data`, `oref`, `predict`, `reports`, `sport`, `sync` and
  `auth/permissions.js`), as the full server serves them under `/src/`;
- `site.js` saying the pages are static (`STATIC = true`), and `sw.js`, the
  service worker;
- PGlite's browser files, about 16 MB, chiefly `pglite.wasm` and
  `pglite.data`;
- `migrations.json`, written at build time instead of by a route;
- the MCP package `mcp/local-<version>.tgz`, `mcp/local.json` naming the
  current one, and `mcp/local.tgz`, which starts the current one, built by
  `src/mcp/pack.js` at build time.

The pages must not call any route the full server answers itself; the
worker has to answer everything.

**The domain.** The static server is `https://loopk.cc`, the custom domain
of the loopk repository's GitHub Pages:

- In Cloudflare's DNS, `@` and `www` are CNAMEs to `buessow.github.io`,
  with the proxy off ("DNS only"). Cloudflare flattens the CNAME on `@`,
  so GitHub's addresses never have to be maintained here.
- `www.loopk.cc` redirects to `loopk.cc`.

It needs an origin of its own, rather than sharing one such as
`code.robertbuessow.com` (which is `buessow.github.io`):

- Every project published under `buessow.github.io` appears there as
  `code.robertbuessow.com/<repo>/`. All of them share one origin, and with
  it one `localStorage` and one IndexedDB. Any of those projects' pages
  could read loopk's cached data, which is health data and not encrypted,
  and loopk's settings.
- A passkey belongs to the domain (its RP ID). On a shared origin, loopk's
  passkey would belong to every project there. A dedicated domain also
  means it never has to change, which a passkey needs.

A project with its own custom domain is served at that domain's root, so
the pages can keep their absolute paths (`/src/…`, `/vendor/…`).

### The browser

1. **Sign-in.** The person enters their Nightscout address and an access
   token made on Nightscout. The page exchanges the token for a JWT at
   `/api/v2/authorization/request/<token>` on Nightscout and reads `status`
   to check what the token may do.
2. **The token in a passkey.** The token is sealed with the secret from the
   passkey's PRF extension (`public/passkey-vault.js`) and kept encrypted in
   this browser. On a later visit, unlocking the passkey (Face ID, a
   fingerprint or the device PIN) opens it again. Neither the passkey nor
   the token is sent anywhere except the token to Nightscout.
   - A passkey belongs to the site's domain (its RP ID). If the static
     server moves to another domain, the token has to be entered again.
   - On a browser without PRF, the token is kept for the tab only
     (`sessionStorage`), and entered again in a new tab.
   - Signing out ends the tab's sign-in and deletes the data this browser
     keeps; the passkey stays, and the sign-in page can forget it.
3. **Everything runs in the worker.** Every page sends its `/api/…` calls
   through `request()` (`public/local.js`). The worker answers all of them
   over the Nightscout data source in PGlite (`public/localapi.js`). This
   covers:
   - the glucose page;
   - reports;
   - profiles;
   - misses;
   - the simulator.

   The Access page shows the agent commands and sport mode's setup; tokens,
   people and following need the full server. Predictions are hidden.
4. **Caching.**
   - Data: the worker's PGlite is kept in IndexedDB (`idb://loopk-<hash of
     the address>`), with what its loader has loaded and its history
     cursor, so a later visit reads only what changed since. One tab at a
     time keeps it (a Web Lock); others work in memory. A cache whose cursor
     is more than a week old, or of an older format, starts again. The
     glucose page's own document cache (`public/browser-cache.js`) works as
     on the full server. Signing out deletes both.
   - Code: a service worker (`sw.js`, written by the build) keeps every file
     of the published version. The pages start without the network, and a
     new version is fetched in the background and used once no page of the
     old one is open.
5. **CORS.** Nightscout must send CORS headers: `ENABLE` includes `cors`.
   The default origin is `*`; a Nightscout limited to some origins must
   include the static server's. The test Nightscout
   (`scripts/nightscout-test.sh`) is set up this way.

### Agents

The agent downloads the MCP package from the static server once, then runs
it in its own Node. The token is part of the agent's MCP configuration:

```
claude mcp add --scope user loopk \
  -e NIGHTSCOUT_URL=https://my.nightscout.example \
  -e NIGHTSCOUT_TOKEN=<token> \
  -- npx -y https://loopk.cc/mcp/local.tgz
```

- `src/mcp/local.js` reads Nightscout directly and answers every tool and
  simulation in the agent's Node. This already works today with the
  variables above.
- npx keeps the package it fetched from a URL and never fetches it again.
  So `mcp/local.tgz` is a small package that never changes
  (`src/mcp/latest.js`): at each start it reads `mcp/local.json` and runs
  the versioned package it names, `npx -y …/mcp/local-<version>.tgz`, which
  npx then keeps. Offline, it runs the version it ran last. The site is
  `LOOPK_SITE`, else `LOOPK_URL`, else `https://loopk.cc`.
- The static server's sign-in page makes these commands from the address
  and token the person entered, in place of the Access page. It does this
  in the browser, so the token is never sent anywhere.
- The agent keeps loopk's settings in a file of its own (see Settings).

### Settings

The full server keeps these in Postgres:

- the loop settings entered for the simulator;
- the AI Test profile;
- sport mode;
- report dashboards.

The static server keeps each of them where it is used, and nothing goes to
Nightscout's settings collection, which only admin tokens may read:

| Setting | Where it is kept | Who sees it |
|---|---|---|
| In the browser: loop settings, AI Test profile, sport mode, report dashboards, chart choices | `localStorage` | This browser only |
| In the agent: loop settings, AI Test profile | A JSON file on the agent's machine: `LOOPK_SETTINGS`, by default `~/.config/loopk/settings.json` | That agent only |

**Not cookies.** The browser sends cookies with every request to the
static host, so settings in a cookie would reach GitHub's servers with each
page load. Cookies also hold only about 4 KB, and the AI Test profile is
larger. `localStorage` stays in the browser, so settings are kept there.

**Moving settings between the browser and an agent.** Moving them is a
file:

- The browser exports one JSON file, `loopk-settings.json`, and imports one
  the same way. This is "Export settings" and "Import settings" on the
  simulator page (`GET` and `PUT /api/simulate/stored`, which the worker
  answers; the full server exports only).
- The agent's settings file has the same format. Copy the exported file to
  `LOOPK_SETTINGS`, and the agent simulates with the person's loop settings.
  When it saves an AI Test profile, that profile is written to the file,
  which the browser can import.
- The format is `{ version: 1, loopSettings, testProfiles, sport }`
  (`settingsDocument` in `src/data/nightscout/settings.js`), what `GET
  /api/simulate/stored` returns. A newer version is refused, not misread;
  an import is checked as the simulator reads it.
- In code, both are `documentSettings({ load, save })` over the whole
  document. In the browser the worker keeps it for the page, which writes
  `localStorage` (other tabs hear of it); `src/mcp/settingsfile.js` reads
  and writes the agent's file.
- Sport mode's configuration (percentage, duration, target) is kept in
  `localStorage` like the rest. Switching it on writes a Profile Switch and
  a Temporary Target to Nightscout's treatments, as on the full server
  (`src/sport/mode.js`). That needs a token that may write treatments; with
  a read token, the switch is hidden.

### What the static server does not have

- **AAPS uploads.** AAPS uploads to Nightscout; loopk only reads it.
- **Following and migration.** There is nothing to follow into.
- **Google sign-in, people, and tokens made in loopk.** Tokens are made on
  Nightscout.
- **Live updates.** The pages read changes again periodically instead of
  receiving Socket.IO events.
- **Heart rate.** Nightscout has no heart rate collection.
- **Predictions.** The prediction model's weights are derived from the
  person's data, so they cannot be published with the code. The static
  server has no predictions, so the glucose page hides the "pred" overlay,
  and `get_status` has no model.
- **The claude.ai connector.** claude.ai needs an MCP endpoint on the web,
  so the agent option needs a local agent such as Claude Code, Codex or
  Gemini CLI. "AI Prompt" on the glucose page can still write the prompt,
  but claude.ai cannot fetch the records.

### What can be checked

- With the static server, the code is a fixed set of files from a
  published commit. It can be compared with the repository, and the
  service worker keeps it from changing between visits.
- The browser's Network tab, including the worker's requests, shows data
  requests only to the Nightscout server.
- The agent's package is the tarball npx keeps in its cache. After the
  install, the agent contacts only `NIGHTSCOUT_URL`, which `lsof -p <pid>`
  shows.

## The two modes side by side

| | Full server | Static server |
|---|---|---|
| Where the data is kept | loopk's Postgres | The person's Nightscout |
| What loopk's host receives | Data, tokens, sessions | Requests for code files (and the visitor's IP address) |
| Where the token is kept | Tokens made in loopk; Google sign-in for pages | A passkey in the browser; the agent's MCP configuration |
| Where pages compute | Server routes; the simulator in the browser | Everything in the browser's worker |
| Agents | `/mcp?token=`, or their own MCP with `LOOPK_URL` | Their own MCP with `NIGHTSCOUT_URL` |
| Uploads from AAPS | To loopk | To Nightscout |
| Where settings are kept | Postgres | The browser's `localStorage`; the agent's settings file |
| Predictions | Yes | No |
| Needs on Nightscout | Nothing (or following) | CORS; a read token, or a write token for sport mode |

## Decisions

- Settings live where they're used: the browser's `localStorage` and the
  agent's settings file, moved between them by exporting and importing a
  JSON file. Nothing is kept in Nightscout's settings collection.
- The static server has no predictions.
- The server variant over Nightscout (`DATA_SOURCE=nightscout`,
  `src/passthrough/`) is removed.
- The static server is hosted on GitHub Pages at `https://loopk.cc`, an
  origin of its own.

## Order of work

All done:

1. Removed the server variant over Nightscout (`src/passthrough/`,
   `DATA_SOURCE=nightscout`, the token sign-in, `src/auth/seal.js`).
2. Settings stores over `localStorage` (browser) and a file (agent), with
   export and import on the simulator page and `LOOPK_SETTINGS` in
   `src/mcp/local.js`.
3. The worker answers every page's calls (`public/localapi.js`), and the
   pages send them through `request()`.
4. Sign-in for the static server (`public/login.js`): the Nightscout
   address and token, the passkey vault, and the agent commands on the
   Access page.
5. The build (`scripts/build-static.js --pages`, run by the "Static pages"
   workflow): the pages, the service worker and the MCP package, and the
   worker's database kept in IndexedDB.
