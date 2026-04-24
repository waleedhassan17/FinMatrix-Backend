# FinMatrix Backend — Heroku Deployment Playbook

This is the exact sequence to put this backend on Heroku. Nothing here is
theoretical — every command is copy-pasteable.

---

## Pre-flight (one-time)

1. **Install the Heroku CLI** <https://devcenter.heroku.com/articles/heroku-cli>
2. **Log in**
   ```bash
   heroku login
   ```
3. **Make sure you are in the repo root (where `package.json` is)** and the
   working tree is committed. Heroku deploys from git.

---

## 1. Create the app + Postgres

Pick a globally-unique app name. If you already have the app, skip `create`.

```bash
# New app on the heroku-24 stack (matches app.json)
heroku create finmatrix-prod --stack heroku-24 --region us

# Attach managed Postgres (mini = cheapest paid tier; use essential-0 for more headroom)
heroku addons:create heroku-postgresql:mini -a finmatrix-prod
```

This gives you:
- `DATABASE_URL` automatically set as a config var (our `database.config.ts`
  now parses it)
- SSL enforced by Heroku Postgres (our code handles `rejectUnauthorized: false`
  because Heroku uses self-signed certs)

---

## 2. Set required config vars

Generate strong secrets **locally**, then push them.

```bash
APP=finmatrix-prod

heroku config:set -a $APP \
  NODE_ENV=production \
  API_PREFIX=api/v1 \
  APP_NAME=FinMatrix \
  APP_URL="https://$APP.herokuapp.com" \
  \
  DB_SYNCHRONIZE=false \
  DB_LOGGING=false \
  DB_SSL=true \
  DB_SSL_REJECT_UNAUTHORIZED=false \
  DB_POOL_MAX=10 \
  DB_POOL_MIN=2 \
  DB_MIGRATIONS_RUN=false \
  \
  JWT_SECRET="$(openssl rand -base64 48)" \
  JWT_ACCESS_EXPIRES_IN=15m \
  JWT_REFRESH_SECRET="$(openssl rand -base64 48)" \
  JWT_REFRESH_EXPIRES_IN=30d \
  \
  BCRYPT_ROUNDS=12 \
  CORS_ORIGINS="https://app.your-frontend-domain.com" \
  THROTTLE_TTL=60 \
  THROTTLE_LIMIT=100 \
  COOKIE_SECRET="$(openssl rand -base64 48)" \
  \
  LOG_LEVEL=info \
  LOG_PRETTY=false \
  \
  UPLOAD_MAX_SIZE_MB=5 \
  UPLOAD_STORAGE_PATH=/tmp/storage \
  \
  EMAIL_ENABLED=false \
  SWAGGER_ENABLED=false \
  SWAGGER_PATH=api/docs
```

Important notes:

- `APP_URL` — set this to the real frontend URL if you are putting the API on a
  subdomain. It's used by Swagger + CORS.
- `CORS_ORIGINS` — replace the placeholder with your actual frontend origin(s),
  comma-separated. No wildcard in production.
- `UPLOAD_STORAGE_PATH=/tmp/storage` — Heroku filesystem is **ephemeral** and
  wiped on every deploy/restart. For real invoice attachments you need S3 or
  Cloudinary; `/tmp` is only safe for transient generation (e.g. PDFs you stream
  straight back in the response).
- `SWAGGER_ENABLED=false` in prod — flip on only temporarily if you need to
  share the docs, or put it behind an IP allowlist via a proxy.

Verify:

```bash
heroku config -a $APP
```

---

## 3. Deploy

The repo already contains:

- `Procfile` — runs migrations in the release phase, then starts the web dyno
  ```
  release: node dist/database/run-migrations.js
  web: node dist/main.js
  ```
- `package.json` → `"heroku-postbuild": "npm run build"` — Heroku's Node
  buildpack runs `nest build` automatically, producing `dist/`.
- `app.json` — reviewers + one-click deploys.

Push to Heroku:

```bash
# if your remote isn't set yet:
heroku git:remote -a finmatrix-prod

git push heroku main          # or: git push heroku master
```

Watch the build + release logs:

```bash
heroku logs --tail -a finmatrix-prod
```

Expected in release phase:

```
[migrations] initializing datasource...
[migrations] running pending migrations...
[migrations] applied 1:
  - InitialSchema1776998538225
```

---

## 4. Smoke-test

```bash
APP=finmatrix-prod

curl -s "https://$APP.herokuapp.com/api/v1/health"         | jq
curl -s "https://$APP.herokuapp.com/api/v1/health/db"      | jq
curl -s "https://$APP.herokuapp.com/api/v1/health/ready"   | jq
```

All three should return `HTTP 200` with `"status":"ok"`.

---

## 5. Create the first admin

Because the demo seed should **never** run against a production DB, create
your first admin through the API:

```bash
APP=finmatrix-prod
BASE="https://$APP.herokuapp.com/api/v1"

# 1. Signup a user (choose any email + strong password)
curl -sS -X POST "$BASE/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@finmatrix.pk","password":"ChangeMeNow!123","fullName":"Admin"}'

# 2. Sign in to get a JWT
TOKEN=$(curl -sS -X POST "$BASE/auth/signin" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@finmatrix.pk","password":"ChangeMeNow!123"}' \
  | jq -r '.data.accessToken')

# 3. Create your company
curl -sS -X POST "$BASE/companies" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Your Company","currency":"PKR"}'
```

---

## 6. Day-two operations

### View config / logs
```bash
heroku config -a finmatrix-prod
heroku logs --tail -a finmatrix-prod
```

### Rotate a secret
```bash
heroku config:set JWT_SECRET="$(openssl rand -base64 48)" -a finmatrix-prod
# Heroku auto-restarts. All access tokens invalidated. Users must re-auth.
```

### Connect to the Postgres DB
```bash
heroku pg:psql -a finmatrix-prod
```

### Run a one-off migration manually (if release phase skipped)
```bash
heroku run "node dist/database/run-migrations.js" -a finmatrix-prod
```

### Scale dynos
```bash
heroku ps:scale web=1        -a finmatrix-prod   # single dyno
heroku ps:scale web=2:standard-1x -a finmatrix-prod   # upgrade + scale
```

### Back up the DB
```bash
# ad-hoc
heroku pg:backups:capture -a finmatrix-prod
heroku pg:backups:download -a finmatrix-prod

# scheduled (daily, retained 7 days)
heroku pg:backups:schedule DATABASE_URL --at '02:00 Asia/Karachi' -a finmatrix-prod
```

---

## 7. Gotchas specific to Heroku

| Issue | Why | Fix |
|---|---|---|
| Filesystem wipes on restart | Heroku dynos are ephemeral | Use S3/Cloudinary for any file you need to keep. |
| `PORT` changes every dyno | Heroku injects `PORT` | Already handled — our `main.ts` reads `process.env.PORT`. |
| SSL cert not trusted by node | Heroku uses a self-signed cert | `DB_SSL_REJECT_UNAUTHORIZED=false` (already in our config). |
| Cold starts on free tier | Hobby dynos sleep | Use `basic` dyno (set in `app.json`) or ping `/health` every 25 min. |
| Timezone | Heroku runs UTC | Set `TZ=Asia/Karachi` via `heroku config:set TZ=Asia/Karachi` if app logic needs local time. |
| Log retention | Heroku keeps ~1500 lines | Add a log drain: `heroku drains:add syslog+tls://logs.papertrailapp.com:XXXX -a finmatrix-prod`. |

---

## 8. Rollback

```bash
heroku releases -a finmatrix-prod            # list releases
heroku rollback v42 -a finmatrix-prod        # pick a known-good release
```

Migrations are **not** auto-reverted on rollback; be careful with destructive
schema changes.

---

## 9. Going further

- **Pipelines**: set up a staging app (`finmatrix-staging`) with the same
  add-ons and `heroku pipelines:create` to get promote-to-prod.
- **Review apps**: enable to get a fresh instance per pull request.
- **APM**: add `heroku addons:create newrelic:wayne` or point the Pino logs at
  Datadog/Better Stack.
- **Custom domain + TLS**: `heroku domains:add api.your-domain.com` then point
  CNAME. Heroku provisions ACM certs automatically on paid dynos.

---

## Quick reference

| What | Where |
|---|---|
| Procfile | `Procfile` |
| Release-phase migrator | `src/database/run-migrations.ts` → compiled to `dist/database/run-migrations.js` |
| Config var catalogue | `app.json` (`env` section) |
| DB connection parser | `src/config/database.config.ts` (handles both `DATABASE_URL` and discrete `DB_*`) |
| Env validator | `src/config/env.validation.ts` (Joi, allows DATABASE_URL OR DB_* but not missing both) |
