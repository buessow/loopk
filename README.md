# Loopk

A small Nightscout-compatible server for AAPS, backed by PostgreSQL, with a glucose log web page and Google sign-in.

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
the proxy is the only public entry point for `https://loopk.outabout.cc`.

One-time setup:

1. Point `loopk.outabout.cc` at the server and issue a certificate that includes
   it. Create a Google Auth Platform **Web application** client with the
   redirect URI `https://loopk.outabout.cc/auth/google/callback`.
2. Create the database roles and apply the generated role SQL on the server:

   ```sh
   LOOPK_REMOTE=ubuntu@outabout ./setup-db-users.sh --with-prod
   ssh ubuntu@outabout 'sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres < ~/create-db-users.sql && shred -u ~/create-db-users.sql'
   ```

3. Render the production-only environment from the OAuth client JSON and the
   generated production database password. This streams secrets directly to a
   mode-600 file on the server; never commit it.

   ```sh
   npm run render:production-env -- /path/to/google-client.json \
     | ssh ubuntu@outabout 'install -d -m 755 /opt/outabout-infra/services/loopk && install -m 600 /dev/stdin /opt/outabout-infra/services/loopk/.env'
   ```

Deploy current source with:

```sh
./deploy.sh
```

It syncs source while preserving the server `.env`, applies all migrations
before the new container starts, builds with host networking (required by this
server), validates/reloads the proxy, and checks the backend endpoint.
