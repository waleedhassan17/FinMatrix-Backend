# FinMatrix Backend

Multi-tenant accounting + delivery management SaaS. **Module 1** covers Authentication, Company Management, and all Core Accounting APIs (AR + AP) — **77 endpoints**.

All endpoints return the standard envelope:

```json
// Success
{ "success": true, "data": { ... }, "message": "optional" }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human readable" } }
```

Base URL: `/api/v1`

---

## Tech Stack

- Node.js 20 LTS • NestJS 10 • TypeScript (strict)
- PostgreSQL 15 • TypeORM 0.3.x
- `@nestjs/jwt` + `@nestjs/passport` + `bcrypt` for auth
- `class-validator` / `class-transformer` (global `ValidationPipe`, `whitelist: true, transform: true`)
- `@nestjs/swagger` → OpenAPI at `/api/docs`
- `nestjs-pino` structured logs, `@nestjs/throttler` rate limiting, `helmet` security headers
- `decimal.js` for money (never JS floats)
- `pdfkit` for invoice PDFs

---

## Quick Start

### 1. Prerequisites

- Node.js 20.x (`node -v`)
- Docker Desktop (for Postgres + pgAdmin)

### 2. Start PostgreSQL + pgAdmin

```bash
docker compose up -d
docker compose ps
```

- Postgres: `localhost:5432` (db `finmatrix`, user `finmatrix_user`)
- pgAdmin:  http://localhost:5050 (admin@finmatrix.local / admin)

### 3. Install + configure

```bash
npm install --legacy-peer-deps
cp .env.example .env
# edit .env if needed
```

> ⚠️ **Windows / low disk:** if `npm install` fails with `ENOSPC`, point npm cache and temp at a drive with space:
> ```powershell
> npm config set cache D:\npm-cache
> $env:TMP="D:\npm-tmp"; $env:TEMP="D:\npm-tmp"
> ```

### 4. Run

```bash
npm run start:dev
```

- API: http://localhost:3000/api/v1
- Health: http://localhost:3000/api/v1/health
- Swagger: http://localhost:3000/api/docs
- OpenAPI JSON: http://localhost:3000/api/docs-json

### 5. Tests

```bash
npm test            # unit
npm run test:e2e    # end-to-end (requires Postgres up)
npm run test:cov    # coverage
```

### 6. Migrations (Phase 7+)

Local dev uses `DB_SYNCHRONIZE=true`. In production, use migrations:

```bash
npm run migration:generate -- src/database/migrations/InitialSchema
npm run migration:run
npm run migration:revert
```

### 7. Seed demo data

```bash
npm run seed:demo
```

---

## Project Structure

```
src/
├── main.ts                     # bootstrap: Swagger, helmet, global pipes
├── app.module.ts               # Config + TypeORM + Throttler + Pino
├── app.controller.ts           # GET /api/v1/health
├── config/                     # app | database | jwt configs
├── common/
│   ├── base/                   # BaseEntity, BaseCompanyEntity
│   ├── decorators/             # @CurrentUser, @CurrentCompany, @Roles, @PublicRoute
│   ├── filters/                # AllExceptionsFilter → error envelope
│   ├── guards/                 # JwtAuthGuard, RolesGuard, CompanyGuard
│   ├── interceptors/           # ResponseEnvelopeInterceptor → success envelope
│   ├── pipes/                  # ParsePaginationPipe
│   └── utils/                  # money.util, reference-generator.util
├── modules/                    # 16 feature modules (filled in Phases 1–5)
├── database/
│   ├── data-source.ts          # TypeORM CLI data source
│   ├── migrations/
│   └── seeds/
└── types/                      # shared enums + interfaces
```

---

## Multi-Tenancy (Critical Rule)

Every business entity belongs to a `companyId`. Enforcement at three layers:

1. **Entity:** all business entities extend `BaseCompanyEntity` (non-null `company_id` column + index).
2. **Guard:** `CompanyGuard` extracts `companyId` from the JWT and attaches it to `request.companyId`.
3. **Repository:** every service query must filter by `companyId`. A user from Company A must **never** see data from Company B.

E2E tests in Phase 6 assert tenant isolation for every resource.

---

## Build Phases

- **Phase 0:** Bootstrap — scaffolding, config, docker-compose, base utilities ✅
- **Phase 1:** Auth + Users + Companies (14 endpoints)
- **Phase 2:** Chart of Accounts + GL + Journal Entries (14)
- **Phase 3:** Customers + Invoices + Payments (18)
- **Phase 4:** Estimates + Sales Orders + Credit Memos (13)
- **Phase 5:** Vendors + Bills + POs + Vendor Credits (18)
- **Phase 6:** Hardening (tests, rate-limit, CORS, Helmet, Postman export)
- **Phase 7:** Deploy prep (migrations, demo seed, DEPLOYMENT.md)

---

## License

UNLICENSED — private.
# FinMatrix-Backend
