# FinMatrix Backend — Data Architecture & Storage Guide

Where every piece of data lives, how it's persisted, how it's secured, how it flows through the system. This is the answer to "where is my data stored?"

---

## 1. The short answer

Everything your users create — companies, invoices, customers, inventory, payroll, deliveries, audit logs — lives in **one PostgreSQL 15 database**.

| Environment | Physical location |
|---|---|
| **Local dev** | Postgres running in Docker on your machine (`docker compose up -d postgres`). Data persisted in the Docker volume `finmatrix-backend_finmatrix_pgdata`. |
| **Prod (Render)** | Render's managed Postgres service `finmatrix-db`. Render runs it on AWS us-west-2 (Oregon) by default. Data replicated on disk, encrypted at rest. |
| **Prod (Heroku)** | Heroku Postgres add-on (AWS us-east-1). |

The backend NEVER keeps important data on its own filesystem. Containers are ephemeral and get wiped on every redeploy.

---

## 2. System diagram

```
┌─────────────────┐         HTTPS          ┌──────────────────────────┐
│                 │  ───────────────────▶  │                          │
│  Frontend (SPA) │  ◀───────────────────  │  finmatrix-api (NestJS)  │
│                 │   JSON over /api/v1    │   Render / Heroku / etc. │
└─────────────────┘                        └────────────┬─────────────┘
                                                        │
                                              TLS + SSL │ (DB_SSL=true)
                                                        ▼
                                              ┌────────────────────┐
                                              │                    │
                                              │   PostgreSQL 15    │
                                              │   62 tables        │
                                              │                    │
                                              └────────────────────┘
```

No message queue, no Redis, no separate file store in the default deployment. Single API + single DB. Scales vertically to low thousands of concurrent users on a $7/mo Render instance.

---

## 3. The database — full table inventory

62 tables across 16 domains. Every row is scoped to a `company_id` (except user/auth tables which are global to the platform).

| Domain | Tables |
|---|---|
| **Auth & users** | `users`, `refresh_tokens`, `password_resets`, `user_companies` |
| **Tenancy** | `companies`, `company_settings` |
| **Ledger** | `accounts`, `journal_entries`, `journal_entry_lines`, `general_ledger` |
| **Sales (A/R)** | `customers`, `invoices`, `invoice_line_items`, `payments`, `payment_applications`, `credit_memos`, `credit_memo_lines`, `credit_memo_applications`, `estimates`, `estimate_line_items`, `sales_orders`, `sales_order_lines` |
| **Purchasing (A/P)** | `vendors`, `bills`, `bill_line_items`, `bill_payments`, `bill_payment_applications`, `vendor_credits`, `vendor_credit_lines`, `purchase_orders`, `purchase_order_lines` |
| **Inventory** | `inventory_items`, `inventory_movements`, `inventory_adjustments`, `inventory_locations`, `stock_transfers`, `stock_transfer_lines`, `physical_counts`, `physical_count_lines` |
| **Delivery** | `deliveries`, `delivery_items`, `delivery_status_history`, `delivery_signatures`, `delivery_issues`, `delivery_personnel_profiles`, `agencies` |
| **Delivery-driver offline** | `shadow_inventory_snapshots`, `inventory_update_requests`, `inventory_update_request_lines` |
| **Banking** | `bank_accounts`, `bank_transactions`, `reconciliations` |
| **Payroll / HR** | `employees`, `payroll_runs`, `paystubs` |
| **Budgeting** | `budgets`, `budget_lines` |
| **Tax** | `tax_rates`, `tax_payments` |
| **Ops** | `notifications`, `audit_trail` |
| **System** | `migrations` (TypeORM tracker) |

Source-of-truth entity definitions: `src/modules/<module>/entities/*.entity.ts`.

---

## 4. Schema evolution — migrations

We use **TypeORM migrations** instead of auto-synchronization.

### Why
`synchronize: true` diffs entities against the DB and runs auto-`ALTER TABLE`s on boot. Convenient in dev, **dangerous in prod** — a renamed field silently drops the column. So in prod it's forced off (`src/config/database.config.ts` checks `NODE_ENV === 'production'`).

### How the pipeline works

```
Entity change ──▶ npm run migration:generate ──▶ reviewable .ts file
                                                        │
                                               git commit
                                                        │
                              git push  ─────────▶  Render/Heroku build
                                                        │
                                           On release phase OR startup:
                                       node dist/database/run-migrations.js
                                                        │
                                      Applies pending migrations atomically
```

### Files

| File | Role |
|---|---|
| `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/src/database/data-source.ts` | TypeORM `DataSource` used by the CLI (supports both `DATABASE_URL` and discrete `DB_*`). |
| `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/src/database/migrations/` | All migration files, timestamp-ordered. |
| `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/src/database/run-migrations.ts` | Release-phase runner (used by Heroku Procfile). |

### Commands

```bash
# Generate a new migration from entity changes
npm run migration:generate -- src/database/migrations/AddCustomerTag

# Apply pending migrations (done automatically on prod boot/release)
npm run migration:run

# Revert last migration
npm run migration:revert
```

---

## 5. Data-flow examples — "where does invoice data actually live?"

### 5.1 Creating an invoice

```
POST /api/v1/invoices
   │
   ▼
InvoicesController (auth, company-guard, role-guard)
   │
   ▼
InvoicesService.create()
   │
   ├─▶  BEGIN TRANSACTION
   │    │
   │    ├─▶  INSERT INTO invoices (...)                        ← row in `invoices`
   │    ├─▶  INSERT INTO invoice_line_items (...)              ← N rows in `invoice_line_items`
   │    ├─▶  INSERT INTO journal_entries (...)                 ← auto-posted JE
   │    ├─▶  INSERT INTO journal_entry_lines (debit AR)        ← ledger lines
   │    ├─▶  INSERT INTO journal_entry_lines (credit Revenue)
   │    ├─▶  INSERT INTO general_ledger (...)                  ← denormalized GL rows
   │    ├─▶  INSERT INTO audit_trail (action='CREATE', ...)    ← audit
   │    └─▶  INSERT INTO notifications (...)                   ← user notification
   │
   ├─▶  COMMIT
   │
   ▼
Response: 201 Created + invoice payload
```

Every business document creation is wrapped in a Postgres transaction — either *all* rows land, or none do. Your invoice can never end up in a half-saved state.

### 5.2 Voiding an invoice (immutable reversal)

Invoices are **immutable after posting**. Voiding does NOT delete:

```
POST /api/v1/invoices/{id}/void
   │
   ▼
   1. UPDATE invoices SET status='VOIDED', voided_at=now()
   2. INSERT INTO journal_entries (type='REVERSAL', ...)
   3. INSERT INTO journal_entry_lines (debits/credits swapped)
   4. INSERT INTO audit_trail (action='VOID', before=..., after=...)
```

You can always read the full history via `GET /audit/resource/invoice/{id}`.

### 5.3 Delivery driver offline sync

Delivery drivers operate in the field with spotty connectivity. They use:

```
Driver's phone                              Backend
─────────────                              ─────────
[local SQLite cache]                       PostgreSQL
      │                                         │
      │  POST /shadow-inventory/sync            │
      │ ───────────────────────────────────────▶│  snapshot saved to shadow_inventory_snapshots
      │                                         │
      │  driver works offline...                │
      │                                         │
      │  POST /inventory-approvals              │
      │ ───────────────────────────────────────▶│  pending rows in inventory_update_requests
      │                                         │
                                            admin reviews:
                                            PATCH /inventory-approvals/{id}/review
                                               │
                                               ├─▶ UPDATE inventory_items.quantity
                                               ├─▶ INSERT inventory_movements
                                               └─▶ INSERT audit_trail
```

The shadow tables isolate driver-submitted data until an admin approves. **Real inventory is never mutated by a driver directly.**

---

## 6. What about files? (PDFs, attachments, images)

### 6.1 PDFs (invoice downloads)

Generated **on demand** by `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/src/modules/invoices/invoice-pdf.service.ts` using `pdfkit`. Streamed directly back to the client — **never written to disk**.

### 6.2 Future: attachments / logos / signatures

Currently **not implemented**. The disk paths in the codebase (`UPLOAD_STORAGE_PATH=/tmp/storage`) are stubs.

When you add file uploads, do NOT write to the local filesystem in production:
- **Render / Heroku containers are ephemeral** — `/tmp` survives only until the next restart or deploy.
- Use **S3-compatible object storage** instead. Recommended:
  - **AWS S3** (cheapest per-GB, most integrations)
  - **Cloudflare R2** (S3-compatible, zero egress fees)
  - **Backblaze B2** (cheap, S3-compatible)

Expected migration when that feature lands:
```
src/
  common/
    storage/
      storage.service.ts        ← abstract interface
      s3.provider.ts            ← implementation
```
Env vars: `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_ENDPOINT` (optional for R2/B2).

### 6.3 Logs

Structured JSON logs from Pino go to **stdout**. Render / Heroku captures stdout and shows it in their dashboard log viewer (retained **7 days free**).

For long-term retention + search, add a **log drain** to a third-party service:
- Better Stack (Logtail) — free tier 1GB/mo
- Papertrail — free tier 100MB/day
- Datadog / Grafana Loki — paid, richer analytics

One command on Render/Heroku to set it up — see `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/RENDER_DEPLOY.md` §5 / `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/HEROKU_DEPLOY.md` §7.

---

## 7. Security model — who sees what

### 7.1 Authentication layers

```
┌──────────────────────────────────────────────────────────┐
│ 1. TLS termination (Render/Heroku)                       │  HTTPS
├──────────────────────────────────────────────────────────┤
│ 2. Helmet (secure HTTP headers)                          │  XSS / clickjacking
├──────────────────────────────────────────────────────────┤
│ 3. CORS (exact-origin allowlist)                         │  browser-level guard
├──────────────────────────────────────────────────────────┤
│ 4. Rate limiting (nestjs/throttler)                      │  brute-force defense
├──────────────────────────────────────────────────────────┤
│ 5. JWT verification (JwtAuthGuard)                       │  who are you?
├──────────────────────────────────────────────────────────┤
│ 6. Company membership check (CompanyGuard)               │  which tenant?
├──────────────────────────────────────────────────────────┤
│ 7. Role/permission check (RolesGuard)                    │  can you do this?
├──────────────────────────────────────────────────────────┤
│ 8. ValidationPipe (class-validator DTOs)                 │  shape + sanity
├──────────────────────────────────────────────────────────┤
│ 9. Service layer (domain logic)                          │
├──────────────────────────────────────────────────────────┤
│10. TypeORM Repositories (parameterized queries only)     │  no SQL injection
├──────────────────────────────────────────────────────────┤
│11. PostgreSQL (row-level via WHERE company_id=...)       │
└──────────────────────────────────────────────────────────┘
```

### 7.2 Secrets

Never committed. Always read from env vars:

| Secret | Rotation |
|---|---|
| `JWT_SECRET` | Rotate → invalidates all access tokens. Users keep refresh tokens unless you rotate that too. |
| `JWT_REFRESH_SECRET` | Rotate → forces all users to log in again. Use after a suspected breach. |
| `COOKIE_SECRET` | Used if you enable signed cookies in the future. |
| `DB_PASSWORD` (or `DATABASE_URL`) | Managed by Render/Heroku; rotate via their dashboard. |

Generators:
```bash
openssl rand -base64 48   # any JWT_* or COOKIE_SECRET
```

### 7.3 Roles (currently implemented)

Defined in `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/src/modules/users/entities/user.entity.ts`:

- `SUPER_ADMIN` — platform owner (invisible to regular users).
- `ADMIN` — company owner / operator. Full access within the company.
- `DELIVERY_PERSONNEL` — restricted. Only sees `/deliveries/my/assigned`, `/shadow-inventory`, `/inventory-approvals` (create only).

Role gates are declared per-route with `@Roles(UserRole.ADMIN)`.

---

## 8. Backup & recovery

### Render free tier
**No automated backups.** Take manual dumps:
```bash
pg_dump "$(render dashboard → finmatrix-db → External Database URL)" \
   > finmatrix-backup-$(date +%F).sql
```
Upgrade to `basic-256mb` ($7/mo) for daily automated backups with 7-day retention.

### Heroku mini / basic
Automated backups on paid plans. Schedule daily:
```bash
heroku pg:backups:schedule DATABASE_URL --at '02:00 Asia/Karachi' -a finmatrix-prod
```

### Restore procedure (any platform)
```bash
psql "$NEW_DATABASE_URL" < finmatrix-backup-2026-04-24.sql
```

Test restores **quarterly** — a backup that's never been restored is not a backup.

---

## 9. Performance characteristics & scaling path

### Current defaults

| Resource | Setting | File |
|---|---|---|
| DB connection pool (max) | 10 | `DB_POOL_MAX` |
| DB connection pool (min) | 2 | `DB_POOL_MIN` |
| Statement timeout | 30s | `src/config/database.config.ts` |
| Query timeout | 30s | same |
| HTTP rate limit | 100 req/min/IP | `THROTTLE_LIMIT` |
| Request body max | 1 MB JSON, 5 MB uploads | `UPLOAD_MAX_SIZE_MB` |

### When to scale

| Symptom | First fix | Second fix |
|---|---|---|
| p95 latency > 500ms | Add indexes on common filters (company_id + date columns) | Move to a bigger dyno/instance |
| Connection pool exhausted | Raise `DB_POOL_MAX` | Upgrade DB CPU tier |
| Queries timing out | Profile with `DB_LOGGING=true`, add indexes | Shard hot tables (e.g. audit_trail) |
| Backlog of notifications / PDFs | Move to async queue (BullMQ + Redis) | Split into worker service |

### Indexes already in place
TypeORM auto-creates indexes for all `@PrimaryGeneratedColumn`, `@Index`, and foreign-key columns. Common composite indexes to **add in a follow-up migration** when traffic grows:
- `invoices (company_id, status, created_at)`
- `journal_entry_lines (account_id, entry_date)`
- `audit_trail (company_id, created_at)`
- `deliveries (company_id, status)`

---

## 10. Compliance checklist

If you plan to process real accounting data (not just demo), verify:

- [ ] Backups automated + off-platform copy (e.g. monthly SQL dump → S3).
- [ ] SSL enforced for DB (`DB_SSL=true` ✅ already on).
- [ ] Secrets rotated from the original dev values before go-live.
- [ ] `SWAGGER_ENABLED=false` in prod (or behind IP allowlist).
- [ ] `CORS_ORIGINS` is the exact production frontend origin (no `*`).
- [ ] `BCRYPT_ROUNDS ≥ 12` (currently 12 ✅).
- [ ] Audit log writes confirmed for every mutating endpoint (spot-check via `/audit`).
- [ ] PII minimized — don't log request bodies at `info` level in prod.
- [ ] Logs shipped to a service with retention ≥ 90 days if required by your regulator.
- [ ] Right-to-erasure flow (GDPR art. 17 etc.) — plan this before first real user.

---

## 11. File inventory — where to find everything

| Concern | Location |
|---|---|
| Entity definitions (DB schema source of truth) | `src/modules/*/entities/*.entity.ts` |
| DTOs (request/response shapes) | `src/modules/*/dto/*.dto.ts` |
| Services (domain logic) | `src/modules/*/*.service.ts` |
| Controllers (HTTP routes) | `src/modules/*/*.controller.ts` |
| DB connection config | `src/config/database.config.ts` |
| Env validation | `src/config/env.validation.ts` |
| Migrations | `src/database/migrations/` |
| Seeds | `src/database/seeds/demo-data.seed.ts` (dev only, never run in prod) |
| Auth guards | `src/modules/auth/guards/` |
| Common decorators | `src/common/decorators/` |
| Dockerfile | `Dockerfile` |
| Render Blueprint | `render.yaml` |
| Heroku config | `Procfile` + `app.json` |
| Deploy playbooks | `RENDER_DEPLOY.md`, `HEROKU_DEPLOY.md` |
| This doc | `docs/DATA_ARCHITECTURE.md` |
| API reference | `docs/API_REFERENCE.md` |
| Endpoint list (raw) | `docs/endpoints.txt` |
