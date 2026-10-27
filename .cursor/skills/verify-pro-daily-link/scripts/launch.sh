#!/usr/bin/env bash
# Point hosted staging at origin/main, then wait until doctor can see the new build.
# Refuses a non-fast-forward. Does not push main and does not deploy production.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
if [[ "${PDL_VERIFY_RESET_STAGING:-}" == "1" ]]; then
  git fetch origin main
  git fetch origin staging
  SHA="$(git rev-parse origin/main)"
  if ! git merge-base --is-ancestor origin/staging "$SHA"; then
    echo "origin/staging is not an ancestor of origin/main. Refusing to reset staging." >&2
    exit 1
  fi
  git push origin "${SHA}:staging"
  echo "Pushed ${SHA} to staging. Waiting for the new build."
fi
exec node "$(dirname "$0")/doctor.cjs" --wait --timeout-ms "${PDL_VERIFY_WAIT_MS:-900000}"
