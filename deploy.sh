#!/usr/bin/env bash
# Deploys main: pushes it to origin main and origin production (which starts
# the "Build and deploy" workflow), waits for that workflow run to finish and
# checks that the server answers.
#
#   ./deploy.sh              # from main, or from a branch (asks to merge it into main first)
#   ./deploy.sh --no-test    # skip npm test before pushing
#
# Needs a clean working tree and the GitHub CLI (gh), signed in.
# LOOPK_URL (default https://loopk.robertbuessow.com) is the server checked afterwards.
set -euo pipefail

URL="${LOOPK_URL:-https://loopk.robertbuessow.com}"
WORKFLOW='Build and deploy'
RUN_TESTS=1
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TESTS=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"
die () { echo "deploy: $*" >&2; exit 1; }
command -v gh > /dev/null || die 'needs the GitHub CLI (gh)'
[ -z "$(git status --porcelain)" ] || die 'the working tree has uncommitted changes; commit or stash them first'

start=$(git branch --show-current)
[ -n "$start" ] || die 'not on a branch'
git fetch -q origin main production

# main must not be behind or apart from origin/main.
update_main () {
  git switch -q main
  git merge -q --ff-only origin/main || die 'local main and origin/main have diverged; sort that out first'
}

if [ "$start" != main ]; then
  ahead=$(git rev-list --count "main..$start")
  read -r -p "You are on '$start' ($ahead commits not in main). Merge it into main first? [y]es / [n]o, deploy main as it is / [a]bort: " answer
  case "$answer" in
    y|Y|yes)
      update_main
      if ! git merge --ff-only -q "$start" 2> /dev/null; then
        git merge --no-edit "$start" || { git merge --abort; git switch -q "$start"; die "merging '$start' into main failed; nothing was pushed"; }
      fi
      ;;
    n|N|no) update_main ;;
    *) echo 'Aborted.'; exit 1 ;;
  esac
else
  update_main
fi

sha=$(git rev-parse HEAD)
if [ "$(git rev-parse origin/production)" = "$sha" ]; then
  echo "Production already has main ($(git log -1 --format='%h %s'))."
  read -r -p 'Deploy it again anyway? [y/N]: ' again
  [ "$again" = y ] || [ "$again" = Y ] || { [ "$start" = main ] || git switch -q "$start"; exit 0; }
fi
echo "Deploying $(git log -1 --format='%h %s')"
git log --oneline origin/production..HEAD | sed 's/^/  /'

if [ "$RUN_TESTS" = 1 ]; then
  echo '== npm test'
  log=$(mktemp -t loopk-deploy-test)
  npm test --silent > "$log" 2>&1 || { tail -30 "$log"; die "tests failed; nothing was pushed (log: $log)"; }
  grep -E '^ℹ (pass|fail)' "$log" | tr '\n' ' '; echo
fi

# Runs for this commit that exist already (a redeploy of the same commit).
runs_for () {
  gh run list -w "$WORKFLOW" -b production -L 20 --json databaseId,headSha \
    -q "map(select(.headSha == \"$sha\")) | .[].databaseId"
}
before=" $(runs_for | tr '\n' ' ') "

echo '== push'
git push -q origin main
if [ "$(git rev-parse origin/production)" = "$sha" ]; then
  # Same commit: pushing does not start a run, so start one by hand.
  gh workflow run "$WORKFLOW" --ref production
else
  git push -q origin main:production
fi

echo "== waiting for the '$WORKFLOW' run of ${sha:0:7}"
run=''
for _ in $(seq 1 60); do
  for id in $(runs_for); do
    case "$before" in *" $id "*) ;; *) run=$id ;; esac
  done
  [ -n "$run" ] && break
  sleep 3
done
[ -n "$run" ] || die "no workflow run for ${sha:0:7} appeared; check: gh run list -w '$WORKFLOW'"
gh run watch "$run" --exit-status --interval 10 || die "the deploy failed; see: gh run view $run --log-failed"

echo "== checking $URL"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null --max-time 10 "$URL/login" && curl -fsS -o /dev/null --max-time 10 "$URL/api/v3/version"; then
    echo "Deployed ${sha:0:7}; $URL is up."
    [ "$start" = main ] || git switch -q "$start"
    exit 0
  fi
  sleep 3
done
die "the workflow succeeded but $URL does not answer"
