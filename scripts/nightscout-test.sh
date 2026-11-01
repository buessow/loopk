#!/usr/bin/env bash
# A Nightscout for testing loopk against, on this machine: the release
# NS_VERSION from source in .cache/nightscout, its own MongoDB (port 27018,
# data in .cache/nightscout-db) and Nightscout on port NS_PORT, with CORS on
# (ENABLE cors, any origin: Nightscout's default) as the browser version of
# loopk needs. Its API secret and two access tokens, loopk-read (readable)
# and loopk-admin (admin), are written to .cache/nightscout.env, with its
# address (NS_URL) for the scripts that fill it.
#
#   scripts/nightscout-test.sh start   installs on first use, starts both
#   scripts/nightscout-test.sh stop
set -euo pipefail

NS_VERSION=v15.0.9
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache"
NS="$CACHE/nightscout"
DB="$CACHE/nightscout-db"
ENV_FILE="$CACHE/nightscout.env"
NS_PORT=1340
MONGO_PORT=27018
URL="http://localhost:$NS_PORT"

install () {
  if [ ! -d "$NS" ]; then
    git clone -q --depth 1 --branch "$NS_VERSION" https://github.com/nightscout/cgm-remote-monitor.git "$NS"
  fi
  if [ ! -d "$NS/node_modules" ]; then
    (cd "$NS" && npm ci --no-audit --no-fund)
  fi
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    echo "NS_API_SECRET=$(openssl rand -hex 12)" > "$ENV_FILE"
  fi
}

start () {
  install
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  mkdir -p "$DB"
  if ! nc -z localhost "$MONGO_PORT" 2>/dev/null; then
    mongod --dbpath "$DB" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$CACHE/nightscout-mongod.log" > /dev/null
  fi
  if ! nc -z localhost "$NS_PORT" 2>/dev/null; then
    (cd "$NS"
    nohup env \
      MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/nightscout" \
      API_SECRET="$NS_API_SECRET" \
      PORT="$NS_PORT" HOSTNAME=127.0.0.1 INSECURE_USE_HTTP=true \
      BASE_URL="$URL" \
      ENABLE="careportal basal iob cob bolus cage sage iage bage pump openaps cors" \
      AUTH_DEFAULT_ROLES=denied \
      DISPLAY_UNITS=mmol TIME_FORMAT=24 \
      node lib/server/server.js > "$CACHE/nightscout.log" 2>&1 &
      echo $! > "$CACHE/nightscout.pid")
    for _ in $(seq 60); do
      curl -sf "$URL/api/v1/status.json" > /dev/null 2>&1 && break
      sleep 1
    done
  fi
  tokens
  { grep -v '^NS_URL=' "$ENV_FILE"; echo "NS_URL=$URL"; } > "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE"
  echo "Nightscout $NS_VERSION at $URL (log: .cache/nightscout.log; secret and tokens: .cache/nightscout.env)"
}

# Makes the access tokens on first start and writes them to the env file.
tokens () {
  grep -q '^NS_READ_TOKEN=' "$ENV_FILE" && return
  NS_API_SECRET="$NS_API_SECRET" NS_URL="$URL" node --input-type=module - >> "$ENV_FILE" <<'EOF'
import crypto from 'node:crypto';
const secret = crypto.createHash('sha1').update(process.env.NS_API_SECRET).digest('hex');
const api = (path, body) => fetch(process.env.NS_URL + path, {
  method: body ? 'POST' : 'GET',
  headers: { 'api-secret': secret, 'Content-Type': 'application/json' },
  body: body && JSON.stringify(body),
}).then((r) => {
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
});
for (const [name, roles] of [['loopk-read', ['readable']], ['loopk-admin', ['admin']]]) {
  const have = await api('/api/v2/authorization/subjects');
  if (!have.some((s) => s.name === name)) await api('/api/v2/authorization/subjects', { name, roles });
}
const subjects = await api('/api/v2/authorization/subjects');
const token = (name) => subjects.find((s) => s.name === name).accessToken;
console.log(`NS_READ_TOKEN=${token('loopk-read')}`);
console.log(`NS_ADMIN_TOKEN=${token('loopk-admin')}`);
EOF
}

stop () {
  if [ -f "$CACHE/nightscout.pid" ]; then
    kill "$(cat "$CACHE/nightscout.pid")" 2>/dev/null || true
    rm -f "$CACHE/nightscout.pid"
  fi
  # mongod --shutdown is Linux only; the lock file holds its process id.
  if [ -s "$DB/mongod.lock" ]; then
    kill "$(cat "$DB/mongod.lock")" 2>/dev/null || true
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
