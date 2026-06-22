#!/usr/bin/env bash
# Local run of the built backend against the Neon DB (sandbox-only helper).
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL='postgresql://neondb_owner:npg_2EaHBJKwbv5z@ep-round-feather-aizaffmv-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require'
export DB_SSL_REJECT_UNAUTHORIZED=false
export DB_POOL_MAX=2
export DB_POOL_MIN=0
export JWT_SECRET='1547df242a2379061c2ba5a0048b9f9508079d8a4c138db9e6df62ec38e6dd313dbdf2faff71907a27cfc20eba3de650'
export JWT_REFRESH_SECRET='e7c94d7c8dc25522a8fadc051188f9f1d8c7a24d5f26ef8206326e68b0a85f5cc10085705a333bb5cc2419c427884804'
export COOKIE_SECRET='bbc63381a657eab25a5c479fa8bf2e8fe96bd8ea14d1427d9ff10c1358c3e264'
export CORS_ORIGINS='*'
export NODE_ENV=development
export APP_URL='http://localhost:3000'
export PORT=3000
export SWAGGER_ENABLED=false
export PIN_HOST='ep-round-feather-aizaffmv-pooler.c-4.us-east-1.aws.neon.tech'
export PIN_IP='98.91.36.187'
export NODE_OPTIONS='--dns-result-order=ipv4first'

exec node -r ./scripts/dns-pin.js dist/main.js
