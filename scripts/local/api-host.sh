#!/usr/bin/env bash
# The local test stack without building the API image: the stack's own
# Postgres container (:5434) and the API built from this checkout, run on this
# machine with the same settings as docker-compose.local.yml (production mode,
# Cloudinary / email / WhatsApp off, local-only dummy secrets, :3100).
#
# Use it when a Docker build is slow (it downloads every package again).
# It never reads this repository's .env: the API runs from an empty directory,
# so the dev database and real keys cannot be picked up.
#
#   scripts/local/api-host.sh            # build, then run in the foreground
#   scripts/local/api-host.sh --no-build # run the last build
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
docker compose -f docker-compose.local.yml -p finmatrix-local up -d db
for _ in $(seq 1 60); do
  docker compose -f docker-compose.local.yml -p finmatrix-local exec -T db pg_isready -U finmatrix_local -d finmatrix_local >/dev/null 2>&1 && break
  sleep 1
done
[[ "${1:-}" == "--no-build" ]] || npm run build

RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/finmatrix-local-api"
mkdir -p "$RUN_DIR"
# The app finds its migrations at dist/… relative to where it starts: the
# build is linked in (and nothing else, so no .env).
ln -sfn "$REPO/dist" "$RUN_DIR/dist"
cd "$RUN_DIR"
exec env -i PATH="$PATH" HOME="$HOME" \
  NODE_ENV=production \
  PORT=3100 \
  API_PREFIX=api/v1 \
  APP_URL=http://localhost:3100 \
  WEB_FALLBACK_URL=http://localhost:5174 \
  CORS_ORIGINS=http://localhost:5174,http://127.0.0.1:5174 \
  DB_HOST=127.0.0.1 \
  DB_PORT=5434 \
  DB_USERNAME=finmatrix_local \
  DB_PASSWORD=local-only-db-password \
  DB_NAME=finmatrix_local \
  DB_SSL=false \
  DB_SYNCHRONIZE=false \
  DB_MIGRATIONS_RUN=true \
  JWT_SECRET=fc53868861057d30c8459aa1b6ca47bfeb8aae85305be3a4 \
  JWT_REFRESH_SECRET=2074544f2157d9b7f8f02b95722afbdc33dc08f6b3258ee2 \
  COOKIE_SECRET=101cc7202c1b70e855b40c20c7336b1ba0648e9029219a88 \
  CREDENTIAL_ENCRYPTION_KEY=UVlmFSBJ0tiZo29RAddmEiz7IbpU9WxlPQY2p5M7JTs= \
  EXPORT_TOKEN_SECRET=eRak3aDTe67bAHEfMxRRdYP2lVqz77r3Vc59eULPpss= \
  MESSAGING_ENCRYPTION_KEY=67eC4Mf+VQ0B2YjodGwCE8XPyVBb+sMrVom2eyY6btc= \
  BCRYPT_ROUNDS=10 \
  THROTTLE_LIMIT=1000 \
  SIGNIN_IP_LIMIT=1000 \
  SIGNIN_ACCOUNT_LIMIT=100 \
  EMAIL_ENABLED=false \
  WHATSAPP_ENABLED=false \
  MESSAGING_WORKER_ENABLED=false \
  EXPORT_WORKER_ENABLED=true \
  MIGRATION_READ_WORKER_ENABLED=true \
  MIGRATION_AI_ENABLED=false \
  CLOUDINARY_CLOUD_NAME= \
  CLOUDINARY_API_KEY= \
  CLOUDINARY_API_SECRET= \
  CLOUDINARY_URL= \
  SENTRY_DSN= \
  SWAGGER_ENABLED=true \
  LOG_LEVEL=info \
  node --max-old-space-size=768 "$REPO/dist/main.js"
