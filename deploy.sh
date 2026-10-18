#!/usr/bin/env bash
# Deploy the current checked-out source to the production host. Database DDL is
# applied before the container changes, so an app image never starts against an
# older schema. The compose file, production .env and Apache vhost live in the
# outabout-infra repo (services/loopk, services/proxy); this script only builds
# the image from source and restarts the containers against that compose file.
set -euo pipefail

REMOTE="${LOOPK_REMOTE:-ubuntu@outabout}"
REMOTE_DIR="${LOOPK_REMOTE_DIR:-/opt/outabout-infra/services/loopk}"
# Build context only - kept out of REMOTE_DIR so the infra directory holds just
# the deployed config, as for every other service.
SRC_DIR="${LOOPK_SRC_DIR:-loopk-src}"

if ! ssh "$REMOTE" "test -f '$REMOTE_DIR/.env' && test -f '$REMOTE_DIR/docker-compose.yml'"; then
  echo "Missing $REMOTE_DIR/.env or docker-compose.yml on $REMOTE; deploy outabout-infra's services/loopk and install the protected production environment first." >&2
  exit 1
fi

rsync -az --delete \
  --exclude=.git/ \
  --exclude=.env \
  --exclude=node_modules/ \
  --exclude=mongo-analysis/ \
  --exclude=create-db-users.sql \
  --exclude=admin.png \
  ./ "$REMOTE:$SRC_DIR/"

ssh "$REMOTE" "set -euo pipefail
  cd '$SRC_DIR'
  ./setup-databases.sh --target=local --with-prod
  # This EC2 host's Docker bridge cannot reach the internet; npm ci needs the
  # host's egress path.
  sudo docker build --network host -t loopk:latest .
  sudo docker compose -f '$REMOTE_DIR/docker-compose.yml' up -d --remove-orphans
  for i in 1 2 3 4 5; do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8084/api/v3/version >/dev/null; then
      exit 0
    fi
    sleep 2
  done
  echo 'Loopk did not become ready on 127.0.0.1:8084.' >&2
  exit 1
"
