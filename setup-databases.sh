#!/usr/bin/env bash
#
# Creates and updates the databases loopk uses by applying migrations/*.sql. Idempotent - run it
# after any schema change, and as often as you like. The app itself never runs DDL: its roles only
# get SELECT/INSERT/UPDATE/DELETE, so this script is the one path a schema change takes.
#
#   ./setup-databases.sh --target=local                    # loopkdev + loopk_test on this machine
#   ./setup-databases.sh --target=local --with-prod        # also loopk (run this on the server)
#   LOOPK_REMOTE=user@host ./setup-databases.sh --target=remote   # only loopkdev, over ssh
#   ./setup-databases.sh --target=local --verify           # check only, change nothing
#
# --target has no default: the remote mode writes to shared infrastructure, so which one runs
# should be a choice made on purpose for this invocation.
#
# --target=remote deliberately only ever touches loopkdev there, never loopk (production) or
# loopk_test: production schema is applied by running this script on the server itself with
# --target=local --with-prod, tied to an actual deploy.
#
# Databases and the one role that may read and write each (roles come from setup-db-users.sh,
# which you run first, once):
#   loopkdev    <- loopkdev
#   loopk_test  <- loopktest   (also TRUNCATE: the test suite resets tables between tests)
#   loopk       <- loopk       (only with --with-prod)
#
# Schema changes go in migrations/, one numbered file per change (0001_..., 0002_..., ...). Never
# edit a migration that has been applied anywhere: each file runs once per database, inside its own
# transaction, and is recorded in that database's schema_migrations table, so a fresh database and
# a live one reach the same schema by the same path.
#
# Before it applies migrations to production, the script dumps that database (pg_dump -Fc) to
# $BACKUP_DIR (default ~/loopk-backups); if the dump fails, nothing is migrated. To restore:
#   sudo -u postgres pg_restore --clean --if-exists -d loopk ~/loopk-backups/<file>.dump
#
# To exercise the script without touching anything real, point it at scratch databases:
#   DEV_DB=dev_scratch TEST_DB=test_scratch ./setup-databases.sh --target=local
#   psql -d postgres -c 'drop database dev_scratch' -c 'drop database test_scratch'
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VERIFY_ONLY=0
WITH_PROD=0
TARGET=
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY_ONLY=1 ;;
    --with-prod) WITH_PROD=1 ;;
    --target=local|--target=remote) TARGET="${arg#--target=}" ;;
    -h|--help) sed -n '3,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 --target=local|remote [--with-prod] [--verify]  (try --help)" >&2
  exit 2
fi

REMOTE="${LOOPK_REMOTE:-}"
if [[ $TARGET == remote && -z "$REMOTE" ]]; then
  echo "--target=remote needs LOOPK_REMOTE=user@host." >&2
  exit 2
fi
if [[ $TARGET == remote && $WITH_PROD -eq 1 ]]; then
  echo "--with-prod is only allowed with --target=local (run it on the server itself)." >&2
  exit 2
fi

PROD_DB="${PROD_DB:-loopk}"
TEST_DB="${TEST_DB:-loopk_test}"
DEV_DB="${DEV_DB:-loopkdev}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/loopk-backups}"

# "db:role" pairs this run manages.
if [[ $TARGET == local ]]; then
  PAIRS=("$DEV_DB:loopkdev" "$TEST_DB:loopktest")
  [[ $WITH_PROD -eq 1 ]] && PAIRS+=("$PROD_DB:loopk")
else
  PAIRS=("$DEV_DB:loopkdev")
fi

# Superuser access: `sudo -u postgres` where that OS account exists (apt-installed Postgres),
# plain psql on Homebrew/Postgres.app where whoever ran initdb is the superuser.
if id postgres >/dev/null 2>&1; then
  LOCAL_SUPERUSER=(sudo -u postgres psql)
  LOCAL_PG_DUMP=(sudo -u postgres pg_dump)
else
  LOCAL_SUPERUSER=(psql)
  LOCAL_PG_DUMP=(pg_dump)
fi

# ON_ERROR_STOP matters: without it psql reports an error and keeps going.
run_sql() {  # run_sql <db>  (SQL on stdin)
  if [[ $TARGET == local ]]; then
    PGOPTIONS='-c client_min_messages=warning' "${LOCAL_SUPERUSER[@]}" -v ON_ERROR_STOP=1 -q -d "$1"
  else
    ssh "$REMOTE" "PGOPTIONS='-c client_min_messages=warning' sudo -E -u postgres psql -v ON_ERROR_STOP=1 -q -d '$1'"
  fi
}

query() {  # query <db>  (SQL on stdin, unaligned tuples out)
  if [[ $TARGET == local ]]; then
    "${LOCAL_SUPERUSER[@]}" -v ON_ERROR_STOP=1 -At -d "$1"
  else
    ssh "$REMOTE" "sudo -u postgres psql -v ON_ERROR_STOP=1 -At -d '$1'"
  fi
}

# Production is only ever migrated with --target=local (see --with-prod), so the dump is local too.
backup() {  # backup <db> <first pending migration>
  local file
  file="$BACKUP_DIR/$1-$(date -u +%Y%m%dT%H%M%SZ)-before-${2%.sql}.dump"
  mkdir -p -m 700 "$BACKUP_DIR"
  echo "  [$TARGET] $1 -> $file"
  if ! "${LOCAL_PG_DUMP[@]}" -Fc -d "$1" >"$file"; then
    rm -f "$file"
    echo "Backup of $1 failed; no migrations applied." >&2
    exit 1
  fi
}

apply_migrations() {  # apply_migrations <db>
  local db=$1 applied file name backed_up=0
  run_sql "$db" <<'SQL'
create table if not exists schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);
SQL
  applied=$(query "$db" <<<'select filename from schema_migrations;')
  for file in "$SCRIPT_DIR"/migrations/*.sql; do
    [[ -e "$file" ]] || continue
    name=$(basename "$file")
    grep -qxF "$name" <<<"$applied" && continue
    if [[ $db == "$PROD_DB" && $WITH_PROD -eq 1 && $backed_up -eq 0 ]]; then
      backup "$db" "$name"
      backed_up=1
    fi
    echo "  [$TARGET] $db <- migrations/$name"
    { echo 'begin;'; cat "$file"; printf "\ninsert into schema_migrations (filename) values ('%s');\n" "$name"; echo 'commit;'; } \
      | run_sql "$db"
  done
}

# ---------------------------------------------------------------- preflight

echo "== preflight"
role_list=$(printf "'%s'," "${PAIRS[@]#*:}")
missing_roles=$(query postgres <<SQL
select r from unnest(array[${role_list%,}]) r
 where not exists (select 1 from pg_roles where rolname = r);
SQL
)
if [[ -n "$missing_roles" ]]; then
  echo "  missing roles: $(echo "$missing_roles" | tr '\n' ' ')" >&2
  echo "  run ./setup-db-users.sh first ($( [[ $TARGET == local ]] && echo '--local' || echo "LOOPK_REMOTE=$REMOTE"))." >&2
  exit 1
fi
echo "  [$TARGET] roles present: ${role_list%,}"

# ---------------------------------------------------------------- databases, schema, grants

if [[ $VERIFY_ONLY -eq 0 ]]; then
  echo "== databases ($TARGET)"
  for pair in "${PAIRS[@]}"; do
    db=${pair%%:*}
    # CREATE DATABASE cannot run in a transaction; \gexec runs it only when missing.
    run_sql postgres <<SQL
select 'create database $db' where not exists (select 1 from pg_database where datname = '$db')\gexec
SQL
    echo "  [$TARGET] $db exists"
  done

  echo "== schema ($TARGET)"
  for pair in "${PAIRS[@]}"; do
    apply_migrations "${pair%%:*}"
  done

  echo "== grants ($TARGET)"
  for pair in "${PAIRS[@]}"; do
    db=${pair%%:*} role=${pair#*:}
    table_privs="SELECT, INSERT, UPDATE, DELETE"
    [[ $role == loopktest ]] && table_privs="$table_privs, TRUNCATE"
    run_sql "$db" <<SQL
GRANT CONNECT ON DATABASE $db TO $role;
GRANT USAGE   ON SCHEMA public TO $role;
GRANT $table_privs ON ALL TABLES IN SCHEMA public TO $role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT $table_privs ON TABLES TO $role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $role;
SQL
    echo "  [$TARGET] $db: read-write for $role"
  done
fi

# ---------------------------------------------------------------- verify
#
# has_table_privilege answers "can the app use this table?" without the role's password.

echo "== verify"
failed=0
expected=$(ls "$SCRIPT_DIR"/migrations/*.sql 2>/dev/null | xargs -n1 basename | sort)
for pair in "${PAIRS[@]}"; do
  db=${pair%%:*} role=${pair#*:}
  exists=$(query postgres <<<"select 1 from pg_database where datname = '$db';")
  if [[ -z "$exists" ]]; then
    echo "  [$TARGET] $db: MISSING"
    failed=1
    continue
  fi
  applied=$(query "$db" <<<"select filename from schema_migrations order by 1;" 2>/dev/null || true)
  pending=$(comm -23 <(echo "$expected") <(echo "$applied" | sort) | grep . || true)
  result=$(query "$db" <<SQL
select t.tablename || ' ' ||
       case when has_table_privilege('$role', 'public.' || quote_ident(t.tablename), 'SELECT')
             and has_table_privilege('$role', 'public.' || quote_ident(t.tablename), 'INSERT')
             and has_table_privilege('$role', 'public.' || quote_ident(t.tablename), 'UPDATE')
             and has_table_privilege('$role', 'public.' || quote_ident(t.tablename), 'DELETE')
            then 'ok' else 'DENIED' end
  from pg_tables t
 where t.schemaname = 'public'
 order by t.tablename;
SQL
)
  count=$(echo "$result" | grep -c . || true)
  denied=$(echo "$result" | grep ' DENIED' || true)
  if [[ -n "$pending" ]]; then
    echo "  [$TARGET] $db: PENDING migrations: $(echo "$pending" | tr '\n' ' ')"
    failed=1
  fi
  if [[ -n "$denied" ]]; then
    echo "  [$TARGET] $db: $count tables, PROBLEMS:"
    echo "$denied" | sed 's/^/     /'
    failed=1
  elif [[ -z "$pending" ]]; then
    echo "  [$TARGET] $db: $count tables, schema current, read-write for $role"
  fi
done

if [[ $failed -ne 0 ]]; then
  echo
  echo "Setup incomplete - see above." >&2
  exit 1
fi
echo
echo "All databases ready (target=$TARGET)."
