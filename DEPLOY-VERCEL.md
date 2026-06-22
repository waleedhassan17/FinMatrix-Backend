# Deploying FinMatrix Backend to Vercel

Vercel runs the NestJS API as a **serverless function** (`api/index.ts`) and the
database is a **Neon Postgres** store provisioned through the Vercel dashboard.

## What's already set up (in this repo)
- `api/index.ts` — serverless entry that boots Nest once per warm lambda.
- `vercel.json` — routes every path to that function.
- `.vercelignore` — keeps `node_modules`, `dist`, `storage`, tests out of the upload.
- `.env.production.local` — all env vars with real secrets (gitignored). Only
  `DATABASE_URL` and `APP_URL` still need filling in.

## Caveats to know
- **Bill-photo uploads won't persist.** Serverless filesystems are ephemeral;
  `UPLOAD_STORAGE_PATH=/tmp/storage` keeps writes from crashing but files vanish.
  Move to Vercel Blob / S3 later if you need uploads. Auth + accounting flows are fine.
- Use Neon's **pooled** connection string (host ends in `-pooler`) and keep
  `DB_POOL_MAX=1` so concurrent lambdas don't exhaust connections.

---

## Steps (the ones only you can do are marked 👤)

### 1. 👤 Log in to Vercel
```bash
npx vercel login        # opens browser / emails a code — pick the account waleedhassan17
```

### 2. 👤 Create the Postgres database
In the Vercel dashboard → your project (or team `waleedhassan17s`) → **Storage**
→ **Create Database** → **Postgres** (Neon). After it's created, open it and copy
the **pooled** connection string (`...-pooler...`, looks like
`postgres://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`).

Paste it into `DATABASE_URL` in `.env.production.local`.

### 3. Run migrations + seed (against Neon, from your machine — no deploy needed)
```bash
cd FinMatrix-Backend/FinMatrix-Backend
export $(grep -v '^#' .env.production.local | grep -v '^$' | xargs)
npm run migration:run        # create all tables
npm run seed:superadmin      # platform admin (admin@finmatrix.pk / see ADMIN_PASSWORD)
npm run seed:coa             # default chart of accounts
```

### 4. Link the project + push env vars to Vercel
```bash
npx vercel link              # choose scope waleedhassan17s, create/link project "finmatrix-api"
# Import every var from the local file into Production:
while IFS='=' read -r k v; do
  [ -z "$k" ] && continue; case "$k" in \#*) continue;; esac
  printf '%s' "$v" | npx vercel env add "$k" production
done < <(grep -v '^#' .env.production.local | grep -v '^$')
```
(Or add them by hand in Dashboard → Settings → Environment Variables.)

### 5. Deploy
```bash
npx vercel --prod
```
Vercel prints the live URL, e.g. `https://finmatrix-api.vercel.app`.

### 6. Set APP_URL to that URL, then redeploy
```bash
printf '%s' 'https://finmatrix-api.vercel.app' | npx vercel env add APP_URL production
npx vercel --prod
```

### 7. Smoke-test
```bash
curl -X POST https://finmatrix-api.vercel.app/api/v1/auth/signin \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@finmatrix.pk","password":"<ADMIN_PASSWORD from env file>"}'
```
A JSON body with `tokens.accessToken` = success.

### 8. Point the app at the new backend
In `FinMatrix/src/network/apiHelpers.ts` set:
```js
export const API_BASE_URL = 'https://finmatrix-api.vercel.app/api/v1';
```
(I'll do this for you once the URL is final.)
