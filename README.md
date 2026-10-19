# Loopk

A small Nightscout-compatible server for AAPS, backed by PostgreSQL, with a glucose log web page and Google sign-in.

## How Loopk works

Loopk sits between diabetes devices or AAPS and a PostgreSQL database. AAPS
uses the Nightscout API v3 to upload and synchronize glucose entries,
treatments, device status, profiles, food, and heart-rate data. Loopk exposes
the small API v2 token-exchange endpoint that NSClient needs as well, and sends
live changes through its `/storage` Socket.IO namespace.

Express routes requests to the API, authentication, and static dashboard. The
API maps the known Nightscout fields to typed Postgres columns and child tables;
unrecognized fields are retained in `extra` JSONB so documents can round-trip
without losing data. Each write receives a server-modified timestamp. Clients
use that timestamp, ETags, and collection history endpoints as incremental sync
cursors instead of repeatedly downloading the entire history.

The dashboard in `public/` is a dependency-free browser application. It fetches
the selected glucose range, derives charts and insulin metrics locally, and
caches recent collection data in IndexedDB. On later visits it paints the cache
first, then requests only changes after its stored history cursor.

During a Nightscout migration, configure `FOLLOW_URL` and `FOLLOW_TOKEN`.
Loopk imports history from that server and listens for its live storage events,
so it remains a read-only mirror until AAPS is switched over. A direct MongoDB
migration can seed the database first, allowing following to resume from the
latest imported server cursor rather than replaying years of data.

It implements the parts of the Nightscout API that AAPS's NSClient V3 uses:

- **API v3** (`/api/v3`): `status`, `version`, `lastModified`, and for `entries`, `treatments`, `devicestatus`, `profile`, `food`, `settings` and `heartrate`: search, create (with Nightscout's deduplication), read, update, patch, soft delete and history. The response formats, error messages and `srvModified`/ETag sync cursors match `buessow/cgm-remote-monitor`.
- **Token exchange** (`GET /api/v2/authorization/request/:accessToken`) returns the JWT AAPS refreshes on 401.
- **`/storage` socket.io namespace**: live `create`/`update`/`delete` events after `subscribe { accessToken, collections }`.

Each collection is a table with typed columns for the fields AAPS uses (`migrations/0001_init.sql`; the mapping from document fields to columns is in `src/db/schema.js`). Nested structures have child tables: a profile's named stores and their schedules, the profile embedded in profile switches (`profileJson`), and the loop's predicted glucose curves. `jsonb` is used only for parts without a fixed structure (pump driver and AAPS plugin settings, the bolus wizard result) and for an `extra` column that keeps fields this schema doesn't know, so documents round-trip unchanged.

## Setup

```sh
npm install
./setup-db-users.sh --local          # roles + passwords, written to .env as DATABASE_URL / TEST_DATABASE_URL
./setup-databases.sh --target=local  # databases, migrations/*.sql, grants, verification
npm run token -- create aaps         # read & write access token for AAPS
npm start
```

For local development without Google, `npm run dev` starts the server with `AUTH_DISABLED=true` (only allowed when `BASE_URL` is `http://localhost`): open http://localhost:1337 and you are signed in as an admin. API clients such as AAPS still need an access token.

In AAPS, select NSClient V3, set the URL to this server and the access token to the token printed above.

The app's database roles can only read and write rows. Schema changes go in a new numbered file in `migrations/` and are applied by `./setup-databases.sh`, which you can re-run safely (see `--help`). The server refuses to start while a migration is pending.

## Environment

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres connection (written by `setup-db-users.sh`) |
| `PORT`, `BASE_URL` | Listen port; public URL (used for the Google callback; `https://` enables secure cookies) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client (type "Web application") with redirect URI `<BASE_URL>/auth/google/callback` |
| `ADMIN_EMAILS` | Google accounts that sign in as admin (can manage tokens and people on `/admin`) |
| `ALLOWED_EMAILS` | Further accounts allowed to sign in read-only (admins can also add people on `/admin`) |
| `FOLLOW_URL`, `FOLLOW_TOKEN` | Follow this Nightscout server with this access token (read is enough); see below |
| `MONGO_URL` | Nightscout MongoDB, for the analysis and migration scripts |
| `STATSD_HOST`, `STATSD_PORT` | Netdata StatsD server for the freshness monitor (default `127.0.0.1:8125`) |

## Moving from Nightscout

1. **Analyse** (optional): `npm run analyze:mongo` reads the Nightscout MongoDB given by `MONGO_URL` (read-only) and writes `mongo-analysis/report.md`: the fields each collection has and had over time, their types, duplicates, and how documents map onto the Postgres schema. For a replica set reachable only under its public name, add `directConnection=true` to the URL.
2. **Migrate**: `npm run migrate:mongo` copies MongoDB into `DATABASE_URL` (or `-- --target-url=…`), cleaning documents up on the way (`src/sync/normalize.js`):
   - API v1 documents get their MongoDB `_id` as identifier (as Nightscout serves them), `date`/`created_at` and server timestamps;
   - records stored more than once (same `created_at` + `eventType`, `date` + `type`, or `created_at` + `device`) are stored once: the API v3 copy, or else the latest upload;
   - heart rate from before AAPS had a heart rate collection (`activity`, `HeartRate` treatments) and heart rates AAPS filed in `food` move to `heartrate`;
   - numbers stored as strings (old profiles), times in seconds or microseconds, `tick` as a number, `recieved`, empty objects and NSClient v1 leftovers (`NSCLIENT_ID`, `sysTime`) are fixed.

   It prints what it copied and dropped. Use `--dry-run` to only count, `--replace` to run again over existing data.
3. **Follow** the Nightscout server until you switch AAPS over: set `FOLLOW_URL` to its URL and `FOLLOW_TOKEN` to a read access token there. Loopk then copies every change (API v3 history, nudged by its `/storage` socket), starting where the migration ended, and its own API refuses data changes. Without a migration it copies everything through the API, which is slow for years of data.
4. **Switch**: point AAPS (NSClient V3) at Loopk with a read & write token from `/admin`, and remove `FOLLOW_URL`.

## Tests

`npm test` runs against `TEST_DATABASE_URL` (the `loopk_test` database).

## Production deployment

The production layout on `ubuntu@outabout` uses the existing Dockerised Apache
proxy and host-networked backend services. Loopk listens on private port 8084;
the proxy is the only public entry point for `https://loopk.robertbuessow.com`.

The server side - Postgres roles, the production `.env`, the Apache vhost and
certificate, the CI deploy key - is set up by `outabout-infra`'s Ansible
playbook. The one piece outside it is the Google Auth Platform **Web
application** client, with the redirect URI
`https://loopk.robertbuessow.com/auth/google/callback`; its client secret goes
into the server's `.env` (see `outabout-infra`'s README, "Secrets").

Deploy by pushing to the `production` branch:

```sh
git push origin main:production
```

GitHub Actions builds the image, pushes it to `ghcr.io/buessow/loopk`,
then SSHes to the server and runs `outabout-infra`'s
`services/loopk/deploy.sh`, which pulls the image, applies all migrations
(shipped in the image) before the new container starts, restarts the
containers, and checks the backend endpoint. When migrations are pending,
`setup-databases.sh` first dumps the production database to
`~/loopk-backups/` on the server (restore with
`sudo -u postgres pg_restore --clean --if-exists -d loopk <file>`). A
migration that rewrites large tables locks them until it commits, so the
running app waits during that time. The compose file, the `.env`
template and the Apache vhost live in `outabout-infra`. The workflow needs
the repo secrets `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY`; on the
server, that key is restricted to the deploy script by a forced command in
`authorized_keys`, and `sudo docker login ghcr.io` (a classic token with only
`read:packages`) lets it pull the private image.

Production is monitored by the Netdata Agent on the host. Both containers log
to the systemd journal, which Netdata shows in its Logs tab: filter on
`SYSLOG_IDENTIFIER` `loopk` (one line per API request, with status and
duration; 5xx responses at error priority) or `loopk-monitor`. Netdata's
cgroups collector charts the containers' CPU, memory, and network use. The
same image also runs `loopk-monitor`, a small Postgres freshness monitor that
every ten seconds sends the delay since the newest glucose entry, heart-rate,
treatment, and device-status record as StatsD gauges
(`loopk.<collection>_sync_delay_seconds`) to Netdata on `127.0.0.1:8125`, and
logs a line whenever one of them changes.
