# FinMatrix Backend — Render Deployment Playbook

Copy-pasteable. No credit card required for the free tier.

---

## What you get on the free plan

- **1 web service**, 512 MB RAM, sleeps after 15 min of idle traffic, cold-start
  ~30–60s when the first request wakes it. Perfect for dev/staging or a
  low-traffic internal tool.
- **Managed Postgres 15**, 256 MB storage, **free for 90 days**. After that
  either upgrade to `basic-256mb` ($7/mo) or migrate the data to Neon (also free).
- **Auto-deploys** from GitHub on every `git push`.
- **Automatic HTTPS** on `*.onrender.com` subdomains.

---

## Pre-flight (one-time)

1. **Push the repo to GitHub** (must be a public or private GitHub repo Render
   can access):
   ```bash
   # If you haven't yet:
   git remote add origin git@github.com:YOUR_USER/FinMatrix-Backend.git
   git push -u origin main
   ```
2. **Create a free Render account**: https://dashboard.render.com/register
   (only email + GitHub auth, no card).

---

## 1. Blueprint deploy (one click)

1. In Render dashboard: **New +** → **Blueprint**.
2. Select your FinMatrix-Backend GitHub repo.
3. Render auto-detects `render.yaml` and shows the plan:
   - Service `finmatrix-api` (Docker, free)
   - Database `finmatrix-db` (Postgres 15, free)
4. Hit **Apply**. Render builds the Docker image (~6–10 min first time)
   and starts the service.
5. First build will:
   1. `docker build` using your `Dockerfile`.
   2. Start the container with all env vars injected.
   3. On boot, because `DB_MIGRATIONS_RUN=true`, TypeORM runs
      `InitialSchema1776998538225` against the managed DB, creating all 62
      tables.
   4. App reports healthy once `/api/v1/health` returns 200.

---

## 2. Set the two manual env vars

Render marked two vars as `sync: false` in the Blueprint because they depend
on the final deploy URL / your frontend:

1. Go to **finmatrix-api** → **Environment**.
2. Set:
   - **`APP_URL`** → `https://finmatrix-api-830293a85dd8.herokuapp.com`
     (or whatever hostname Render assigned — see the top of the service page)
   - **`CORS_ORIGINS`** → your frontend origin(s), e.g.
     `https://app.your-domain.com` (comma-separated, no wildcards).
3. Click **Save Changes**. Render redeploys automatically.

If you haven't built the frontend yet, set `CORS_ORIGINS=http://localhost:5173`
temporarily so you can hit the API from your local React dev server.

---

## 3. Smoke-test

```bash
APP=https://finmatrix-api-830293a85dd8.herokuapp.com

# Wake it up (first request after idle takes 30-60s)
curl -s "$APP/api/v1/health"        | jq
curl -s "$APP/api/v1/health/db"     | jq
curl -s "$APP/api/v1/health/ready"  | jq
```

All three should return `"status":"ok"`.

---

## 4. Create the first admin

Demo seeds must **never** run against prod. Use the API:

```bash
APP=https://finmatrix-api-830293a85dd8.herokuapp.com
BASE="$APP/api/v1"

# 1. Signup
curl -sS -X POST "$BASE/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@finmatrix.pk","password":"ChangeMeNow!123","fullName":"Admin"}'

# 2. Signin
TOKEN=$(curl -sS -X POST "$BASE/auth/signin" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@finmatrix.pk","password":"ChangeMeNow!123"}' \
  | jq -r '.data.accessToken')

# 3. Create your first company
curl -sS -X POST "$BASE/companies" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ali Traders","currency":"PKR"}'
```

---

## 5. Day-two operations

### View logs
Dashboard → `finmatrix-api` → **Logs** tab (live tail), or via CLI:
```bash
# Install Render CLI (optional)
brew install render     # macOS; for Linux see https://render.com/docs/cli
render logs -s finmatrix-api --tail
```

### Connect to Postgres
Dashboard → `finmatrix-db` → **Connect** → use the **External Database URL**
with any client (psql, TablePlus, DBeaver):
```bash
psql "$(render dashboard-url-for-db)"   # or copy the URL from the dashboard
```

### Rotate a secret
Dashboard → **Environment** → edit `JWT_SECRET` (click "Generate" again) →
**Save**. Render redeploys and all active tokens are invalidated.

### Manual migration run
If you make a schema change and don't want to wait for the next deploy:
1. Dashboard → `finmatrix-api` → **Shell** (paid plan only), OR
2. Trigger a manual deploy: `Manual Deploy` → `Deploy latest commit`. Since
   `DB_MIGRATIONS_RUN=true`, any pending migration is applied on the next boot.

### Back up the DB
Free-tier Postgres has no automated backups. Take one manually:
```bash
pg_dump "$(render-external-url)" > backup-$(date +%F).sql
```
Automated dailies become available on `basic-256mb` ($7/mo).

---

## 6. Gotchas specific to Render

| Issue | Why | Fix |
|---|---|---|
| Cold starts (~30–60s) on free plan | Free services sleep after 15min idle | Upgrade to Starter ($7/mo), or ping `/health` every 14min from an uptime monitor (UptimeRobot free) |
| Free Postgres expires after 90 days | Render free DB policy | Upgrade to `basic-256mb` ($7/mo) **or** migrate the dump to a free permanent DB like Neon |
| File uploads disappear on redeploy | Docker containers are ephemeral on Render | Already handled: `UPLOAD_STORAGE_PATH=/tmp/storage`. For persistent files add S3/Cloudinary. |
| `preDeployCommand` ignored | Paid feature only | Current config uses `DB_MIGRATIONS_RUN=true` on boot instead. No action needed. |
| Build times out | First Docker build can exceed 15min on free | Move to Native Node runtime (change `runtime: docker` → `runtime: node`, add `buildCommand: npm ci && npm run build`, `startCommand: node dist/main.js`) |
| Healthcheck fails during migration | Boot takes longer on first deploy while migrations apply | Render's default timeout is 90s — usually enough. If it fails, retry the deploy once the DB is seeded. |
| Logs only kept 7 days on free | Render free-tier retention | Add a log drain: Dashboard → Service → **Log Streams** → point at Better Stack / Logtail / Papertrail |

---

## 7. Migrating off the free Postgres when it expires

When the 90-day window ends, you have three choices:

### Option A — Upgrade in place ($7/mo)
Dashboard → `finmatrix-db` → **Upgrade Instance** → `basic-256mb`. No code or
config change.

### Option B — Move to Neon (free forever)
1. Create a Neon project at https://console.neon.tech (email-only, no card).
2. Copy the Neon connection string (ends in `?sslmode=require`).
3. Dump + restore:
   ```bash
   pg_dump "$RENDER_DB_URL" | psql "$NEON_DB_URL"
   ```
4. In Render: Dashboard → **Environment** → remove `DATABASE_URL` binding from
   the Blueprint (delete the `fromDatabase` entry in `render.yaml`, redeploy),
   then add `DATABASE_URL` as a regular env var set to the Neon URL.
5. Delete the Render Postgres instance.

### Option C — Move the app off Render too
Everything you've built is portable: the `Dockerfile`, `DATABASE_URL`
parsing, and migration runner all work unchanged on Fly.io, Koyeb, Railway,
AWS ECS, etc.

---

## 8. Rollback

Dashboard → **Events** tab → pick a previous successful deploy → **Rollback**.

⚠️ Migrations are **not** auto-reverted on rollback. For destructive schema
changes (drop column, etc.) add a paired "down" migration and apply it
manually before rolling back.

---

## Quick reference

| What | Where |
|---|---|
| Blueprint file | `render.yaml` |
| Dockerfile | `Dockerfile` (used because `runtime: docker`) |
| Migration runner | `src/database/run-migrations.ts` (used by `preDeployCommand` on paid plan) |
| Startup migrations | Controlled by `DB_MIGRATIONS_RUN=true` env var on free plan |
| Config var catalogue | `render.yaml` `envVars` section |
| DB connection parser | `src/config/database.config.ts` |
