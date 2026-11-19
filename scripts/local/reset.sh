#!/usr/bin/env bash
# Discard the local test stack's database, rebuild the API from the current
# code, start it, and create the test accounts again. Local only: it works on
# the finmatrix-local Docker project (its own Postgres on :5434), never on the
# dev or production database.
#
#   scripts/local/reset.sh            # discard data, rebuild, seed
#   scripts/local/reset.sh --keep     # keep data, rebuild the API only
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f docker-compose.local.yml -p finmatrix-local)

if [[ "${1:-}" == "--keep" ]]; then
  "${COMPOSE[@]}" up -d --build api
else
  "${COMPOSE[@]}" down -v
  "${COMPOSE[@]}" up -d --build
fi

for _ in $(seq 1 120); do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/api/v1/health)" == "200" ]]; then
    break
  fi
  sleep 1
done
curl -sf -o /dev/null http://localhost:3100/api/v1/health || { echo "API did not start"; "${COMPOSE[@]}" logs --tail 40 api; exit 1; }

if [[ "${1:-}" != "--keep" ]]; then
  TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/local/seed-test-accounts.ts
fi
echo
echo "API  http://localhost:3100/api/v1   (docs: http://localhost:3100/api/docs)"
echo "Web  cd ~/FinMatrix-Web && VITE_API_URL=http://localhost:3100/api/v1 npx vite --port 5174 --strictPort"
