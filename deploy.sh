#!/usr/bin/env bash
# Deploy the current checked-out source to the production host. Database DDL is
# applied before the container changes, so an app image never starts against an
# older schema. The production .env is server-owned and deliberately excluded.
set -euo pipefail

REMOTE="${LOOPK_REMOTE:-ubuntu@outabout}"
REMOTE_DIR="${LOOPK_REMOTE_DIR:-/opt/outabout-infra/services/loopk}"
PROXY_DIR="${LOOPK_PROXY_DIR:-/opt/outabout-infra/services/proxy}"

if ! ssh "$REMOTE" "test -f '$REMOTE_DIR/.env'"; then
  echo "Missing $REMOTE_DIR/.env on $REMOTE; install the protected production environment first." >&2
  exit 1
fi

rsync -az --delete \
  --exclude=.git/ \
  --exclude=.env \
  --exclude=node_modules/ \
  --exclude=mongo-analysis/ \
  --exclude=create-db-users.sql \
  --exclude=admin.png \
  ./ "$REMOTE:$REMOTE_DIR/"

rsync -az deploy/loopk.outabout.cc.conf "$REMOTE:$PROXY_DIR/apache/sites/loopk.outabout.cc.conf"

ssh "$REMOTE" "set -euo pipefail
  cd '$REMOTE_DIR'
  ./setup-databases.sh --target=local --with-prod
  sudo docker compose -f docker-compose.production.yml up -d --build --remove-orphans
  sudo docker compose -f '$PROXY_DIR/docker-compose.yml' exec -T proxy httpd -t
  sudo docker kill --signal=HUP proxy-proxy-1 >/dev/null
  for i in 1 2 3 4 5; do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8084/api/v3/version >/dev/null; then
      exit 0
    fi
    sleep 2
  done
  echo 'Loopk did not become ready on 127.0.0.1:8084.' >&2
  exit 1
"
