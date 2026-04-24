# FinMatrix Backend — API Reference

**For the frontend team.** This is the practical guide. The auto-generated, always-accurate source of truth is Swagger (see §2).

---

## 0. Quick facts

| | |
|---|---|
| Base URL (production) | `https://finmatrix-api.onrender.com/api/v1` |
| Base URL (local) | `http://localhost:3000/api/v1` (or `3100` if port 3000 is in use) |
| Auth scheme | `Authorization: Bearer <accessToken>` (JWT) |
| Default response envelope | `{ "success": true, "data": <payload> }` |
| Error envelope | `{ "success": false, "error": { "code": "...", "message": "..." } }` with a non-2xx HTTP status |
| Content type | `application/json` (unless noted — e.g. PDF endpoints return `application/pdf`) |
| Total endpoints | **170** across **30 modules** |
| Rate limits | Global: 100 req/min per IP. `/auth/signin`: 5/min. `/auth/signup`: 3/hour. `/auth/forgot-password`: 3/15min. `/auth/reset-password`: 5/15min. Over-limit returns **`429 Too Many Requests`**. |

---

## 1. Authentication flow

### 1.1 Signup → Signin → authenticated requests

```http
POST /api/v1/auth/signup
Content-Type: application/json

{
  "email": "admin@finmatrix.pk",
  "password": "ChangeMeNow!123",
  "fullName": "Admin User"
}
```
Returns the created user. No token yet.

```http
POST /api/v1/auth/signin
Content-Type: application/json

{ "email": "admin@finmatrix.pk", "password": "ChangeMeNow!123" }
```
Returns:
```json
{
  "success": true,
  "data": {
    "accessToken":  "eyJhbGciOi...",     // use as Bearer token; expires in 15m
    "refreshToken": "1fa3c9...",         // opaque; expires in 30d; store in httpOnly cookie OR localStorage
    "user": { "id": "uuid", "email": "...", "fullName": "...", "role": "..." }
  }
}
```

Subsequent authenticated requests:
```http
GET /api/v1/auth/me
Authorization: Bearer eyJhbGciOi...
```

### 1.2 Refreshing the access token

Access tokens last **15 minutes**. When you get a `401 Unauthorized` (or pre-emptively near expiry):

```http
POST /api/v1/auth/refresh-token
Content-Type: application/json

{ "refreshToken": "<the refresh token from signin>" }
```

Returns a **new** `accessToken` + `refreshToken`. **Discard the old refresh token** — each refresh rotates.

### 1.3 Multi-company (most endpoints)

A user can belong to multiple companies. Every request to a company-scoped endpoint must tell the server which company it's for via the `x-company-id` header:

```http
GET /api/v1/invoices
Authorization: Bearer <token>
x-company-id: <companyId>
```

Get the user's companies from `GET /api/v1/auth/me` → `data.companies[]`.

### 1.4 Logout
```http
POST /api/v1/auth/signout
Authorization: Bearer <token>
```
Revokes all active refresh tokens for the user.

---

## 2. Swagger — interactive docs (recommended)

When `SWAGGER_ENABLED=true` (currently `false` in prod for security), the full OpenAPI spec + try-it-out UI is at:

- **Local**: `http://localhost:3000/api/docs`
- **Prod**: not exposed; ask DevOps to temporarily flip `SWAGGER_ENABLED=true` if you need it live.

For the frontend team, run locally against a fresh clone:
```bash
git clone <repo>
cd FinMatrix-Backend
cp .env.example .env            # or ask backend team for their local .env
docker compose up -d postgres
npm install
npm run start:dev
# Browse: http://localhost:3000/api/docs
```

Swagger gives you:
- Every endpoint, request shape, response shape, example values.
- "Authorize" button — paste your Bearer token once, all endpoints stay authed.
- "Try it out" executes real requests against your local DB.

---

## 3. Module catalogue

Below is the list of every route, grouped by module. `{param}` = path parameter. `AUTH` = requires Bearer token. `COMPANY` = requires `x-company-id` header.

### 🔐 `auth` — Session management

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | public | Create user. Rate-limited 3/hour. |
| POST | `/auth/signin` | public | Login. Rate-limited 5/min. |
| POST | `/auth/signout` | AUTH | Revoke all refresh tokens. |
| POST | `/auth/refresh-token` | public | Rotate access + refresh token. |
| POST | `/auth/forgot-password` | public | Email password-reset link. 3/15min. |
| POST | `/auth/reset-password` | public | Consume reset token + set new password. 5/15min. |
| GET  | `/auth/me` | AUTH | Current user profile + company memberships. |

### 🏢 `companies` — Tenancy

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST   | `/companies` | AUTH | Create a company; caller becomes OWNER. |
| POST   | `/companies/join` | AUTH | Join an existing company via invite code. |
| GET    | `/companies/{companyId}` | AUTH | Get company details. |
| PATCH  | `/companies/{companyId}` | AUTH | Update company. |
| POST   | `/companies/{companyId}/regenerate-code` | AUTH | Rotate invite code. |
| GET    | `/companies/{companyId}/members` | AUTH | List members. |
| DELETE | `/companies/{companyId}/members/{userId}` | AUTH | Remove a member. |

### 📒 `accounts` — Chart of Accounts

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/accounts` | AUTH+COMPANY | List chart of accounts. |
| POST   | `/accounts` | AUTH+COMPANY | Create account. |
| GET    | `/accounts/{accountId}` | AUTH+COMPANY | Account detail. |
| PATCH  | `/accounts/{accountId}` | AUTH+COMPANY | Update account. |
| PATCH  | `/accounts/{accountId}/toggle` | AUTH+COMPANY | Activate/deactivate. |
| GET    | `/accounts/{accountId}/transactions` | AUTH+COMPANY | Ledger entries for this account. |

### 📗 `ledger` + `journal-entries` — General Ledger

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/ledger` | AUTH+COMPANY | General ledger query (filters: dateFrom, dateTo, accountId, ...). |
| GET    | `/journal-entries` | AUTH+COMPANY | List entries. |
| POST   | `/journal-entries` | AUTH+COMPANY | Create draft entry. |
| GET    | `/journal-entries/{entryId}` | AUTH+COMPANY | Entry detail + lines. |
| PATCH  | `/journal-entries/{entryId}` | AUTH+COMPANY | Update draft. |
| POST   | `/journal-entries/{entryId}/post` | AUTH+COMPANY | Post draft to the ledger (becomes immutable). |
| POST   | `/journal-entries/{entryId}/void` | AUTH+COMPANY | Reverse a posted entry. |
| POST   | `/journal-entries/{entryId}/duplicate` | AUTH+COMPANY | Clone as new draft. |

### 👥 `customers`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/customers` | AUTH+COMPANY | Paginated list. |
| POST   | `/customers` | AUTH+COMPANY | Create. |
| GET    | `/customers/{customerId}` | AUTH+COMPANY | Detail. |
| PATCH  | `/customers/{customerId}` | AUTH+COMPANY | Update. |
| GET    | `/customers/{customerId}/invoices` | AUTH+COMPANY | Invoices for this customer. |
| GET    | `/customers/{customerId}/payments` | AUTH+COMPANY | Payments received from customer. |
| GET    | `/customers/{customerId}/statement` | AUTH+COMPANY | Customer statement (opening + activity + balance). |

### 🧾 `invoices`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/invoices` | AUTH+COMPANY | List (filters: status, customerId, dateFrom/To). |
| POST   | `/invoices` | AUTH+COMPANY | Create invoice with line items. |
| GET    | `/invoices/{invoiceId}` | AUTH+COMPANY | Detail + lines. |
| PATCH  | `/invoices/{invoiceId}` | AUTH+COMPANY | Update draft only. |
| POST   | `/invoices/{invoiceId}/send` | AUTH+COMPANY | Mark as sent (emails when SMTP enabled). |
| POST   | `/invoices/{invoiceId}/void` | AUTH+COMPANY | Void + create reversing JE. Body: `{ reason: string }`. |
| GET    | `/invoices/{invoiceId}/pdf` | AUTH+COMPANY | **Streams `application/pdf`.** |

### 💵 `payments`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/payments` | AUTH+COMPANY | List. |
| GET    | `/payments/{paymentId}` | AUTH+COMPANY | Detail + applied-to invoices. |
| POST   | `/payments/receive` | AUTH+COMPANY | Record a customer payment; apply to one or more invoices. |
| GET    | `/payments/customer/{customerId}/outstanding` | AUTH+COMPANY | Unpaid invoices to apply against. |

### 📝 `estimates`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/estimates` | AUTH+COMPANY | List. |
| POST   | `/estimates` | AUTH+COMPANY | Create. |
| GET    | `/estimates/{estimateId}` | AUTH+COMPANY | Detail. |
| PATCH  | `/estimates/{estimateId}` | AUTH+COMPANY | Update draft. |
| POST   | `/estimates/{estimateId}/convert-to-invoice` | AUTH+COMPANY | Turn approved estimate into an invoice. |

### 🛒 `sales-orders`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET   | `/sales-orders` | AUTH+COMPANY | List. |
| POST  | `/sales-orders` | AUTH+COMPANY | Create. |
| GET   | `/sales-orders/{orderId}` | AUTH+COMPANY | Detail. |
| POST  | `/sales-orders/{orderId}/fulfill` | AUTH+COMPANY | Mark fulfilled (decrements inventory). |
| POST  | `/sales-orders/{orderId}/create-invoice` | AUTH+COMPANY | Generate invoice from SO. |

### 💳 `credit-memos`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/credit-memos` | AUTH+COMPANY | List. |
| POST | `/credit-memos` | AUTH+COMPANY | Create. |
| POST | `/credit-memos/{creditId}/apply` | AUTH+COMPANY | Apply to an invoice. |

### 🏭 `vendors` · `bills` · `vendor-credits` · `purchase-orders`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/vendors` | AUTH+COMPANY | List vendors. |
| POST   | `/vendors` | AUTH+COMPANY | Create. |
| GET    | `/vendors/{vendorId}` | AUTH+COMPANY | Detail. |
| PATCH  | `/vendors/{vendorId}` | AUTH+COMPANY | Update. |
| GET    | `/vendors/{vendorId}/bills` | AUTH+COMPANY | Vendor's bills. |
| GET    | `/vendors/{vendorId}/payments` | AUTH+COMPANY | Vendor payments. |
| GET    | `/bills` | AUTH+COMPANY | List. |
| POST   | `/bills` | AUTH+COMPANY | Create bill. |
| GET    | `/bills/{billId}` | AUTH+COMPANY | Detail + lines. |
| PATCH  | `/bills/{billId}` | AUTH+COMPANY | Update draft. |
| POST   | `/bills/pay` | AUTH+COMPANY | Pay one or more bills. |
| GET    | `/vendor-credits` | AUTH+COMPANY | List. |
| POST   | `/vendor-credits` | AUTH+COMPANY | Create. |
| POST   | `/vendor-credits/{creditId}/apply` | AUTH+COMPANY | Apply to a bill. |
| GET    | `/purchase-orders` | AUTH+COMPANY | List. |
| POST   | `/purchase-orders` | AUTH+COMPANY | Create. |
| GET    | `/purchase-orders/{poId}` | AUTH+COMPANY | Detail. |
| POST   | `/purchase-orders/{poId}/receive` | AUTH+COMPANY | Receive items into inventory. |
| POST   | `/purchase-orders/{poId}/create-bill` | AUTH+COMPANY | Turn PO into a bill. |

### 📦 `inventory` · `inventory-approvals` · `shadow-inventory`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/inventory/items` | AUTH+COMPANY | List items. |
| POST   | `/inventory/items` | AUTH+COMPANY | Create item. |
| GET    | `/inventory/items/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/inventory/items/{id}` | AUTH+COMPANY | Update. |
| PATCH  | `/inventory/items/{id}/toggle` | AUTH+COMPANY | Activate/deactivate. |
| GET    | `/inventory/items/{id}/movements` | AUTH+COMPANY | Stock movement history. |
| POST   | `/inventory/items/{id}/adjust` | AUTH+COMPANY | Manual qty adjustment (creates journal entry). |
| GET    | `/inventory/movements` | AUTH+COMPANY | All movements (filters). |
| POST   | `/inventory/transfers` | AUTH+COMPANY | Create stock transfer between locations. |
| PATCH  | `/inventory/transfers/{id}/complete` | AUTH+COMPANY | Complete transfer. |
| POST   | `/inventory/physical-counts` | AUTH+COMPANY | Submit physical count + auto-adjust. |
| GET    | `/inventory-approvals` | AUTH+COMPANY | Pending delivery-driver requests. |
| POST   | `/inventory-approvals` | AUTH+COMPANY | Delivery person submits inventory change for admin approval. |
| GET    | `/inventory-approvals/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/inventory-approvals/{id}/review` | AUTH+COMPANY | Admin approves/rejects; approval applies to real inventory. |
| GET    | `/shadow-inventory` | AUTH+COMPANY | Delivery person's offline inventory snapshot. |
| POST   | `/shadow-inventory` | AUTH+COMPANY | Save snapshot. |
| PATCH  | `/shadow-inventory/{id}` | AUTH+COMPANY | Update. |
| POST   | `/shadow-inventory/sync/{personnelId}` | AUTH+COMPANY | Sync from central → personnel's shadow copy. |

### 🚚 `deliveries` · `delivery-personnel` · `agencies`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/deliveries` | AUTH+COMPANY | List all. |
| POST   | `/deliveries` | AUTH+COMPANY | Create from invoice/SO. |
| GET    | `/deliveries/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/deliveries/{id}` | AUTH+COMPANY | Update. |
| PATCH  | `/deliveries/{id}/status` | AUTH+COMPANY | Update status (picked_up, in_transit, delivered, failed). |
| POST   | `/deliveries/{id}/auto-assign` | AUTH+COMPANY | Auto-assign driver based on availability. |
| GET    | `/deliveries/{id}/history` | AUTH+COMPANY | Status change trail. |
| GET    | `/deliveries/{id}/issues` | AUTH+COMPANY | Issues reported. |
| POST   | `/deliveries/{id}/issues` | AUTH+COMPANY | Report issue (damaged, refused, etc). |
| GET    | `/deliveries/my/assigned` | AUTH+COMPANY | Driver's own assignments. |
| GET    | `/delivery-personnel` | AUTH+COMPANY | List drivers. |
| POST   | `/delivery-personnel` | AUTH+COMPANY | Onboard a driver. |
| GET    | `/delivery-personnel/{userId}` | AUTH+COMPANY | Driver profile. |
| PATCH  | `/delivery-personnel/{userId}` | AUTH+COMPANY | Update profile. |
| PATCH  | `/delivery-personnel/{userId}/availability` | AUTH+COMPANY | Driver toggles availability. |
| GET    | `/agencies` | AUTH+COMPANY | Third-party delivery agencies. |
| POST   | `/agencies` | AUTH+COMPANY | Add agency. |
| GET    | `/agencies/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/agencies/{id}` | AUTH+COMPANY | Update. |
| PATCH  | `/agencies/{id}/connected` | AUTH+COMPANY | Toggle connection status. |
| DELETE | `/agencies/{id}` | AUTH+COMPANY | Remove. |

### 🏦 `banking`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/banking/accounts` | AUTH+COMPANY | List bank accounts. |
| POST   | `/banking/accounts` | AUTH+COMPANY | Add bank account. |
| GET    | `/banking/accounts/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/banking/accounts/{id}` | AUTH+COMPANY | Update. |
| DELETE | `/banking/accounts/{id}` | AUTH+COMPANY | Remove (must have zero txns). |
| GET    | `/banking/accounts/{id}/transactions` | AUTH+COMPANY | Transactions. |
| POST   | `/banking/transactions` | AUTH+COMPANY | Create transaction (deposit/withdraw/transfer). |
| POST   | `/banking/accounts/{id}/reconcile` | AUTH+COMPANY | Start/commit reconciliation. |
| GET    | `/banking/accounts/{id}/reconciliations` | AUTH+COMPANY | Reconciliation history. |

### 💼 `employees` · `payroll`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/employees` | AUTH+COMPANY | List. |
| POST   | `/employees` | AUTH+COMPANY | Onboard. |
| GET    | `/employees/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/employees/{id}` | AUTH+COMPANY | Update. |
| PATCH  | `/employees/{id}/toggle` | AUTH+COMPANY | Active/inactive. |
| GET    | `/employees/departments/summary` | AUTH+COMPANY | Count by department. |
| GET    | `/payroll` | AUTH+COMPANY | Payroll runs. |
| POST   | `/payroll` | AUTH+COMPANY | Start a payroll run (generates paystubs). |
| GET    | `/payroll/{id}` | AUTH+COMPANY | Run detail + paystubs. |
| PATCH  | `/payroll/{id}/status` | AUTH+COMPANY | Approve / mark paid. |

### 📊 `budgets` · `reports`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/budgets` | AUTH+COMPANY | List budgets. |
| POST   | `/budgets` | AUTH+COMPANY | Create. |
| GET    | `/budgets/{id}` | AUTH+COMPANY | Detail + lines. |
| PATCH  | `/budgets/{id}` | AUTH+COMPANY | Update. |
| DELETE | `/budgets/{id}` | AUTH+COMPANY | Remove. |
| GET    | `/reports/profit-loss` | AUTH+COMPANY | P&L. Query: `dateFrom`, `dateTo`. |
| GET    | `/reports/balance-sheet` | AUTH+COMPANY | As-of balance sheet. Query: `asOf`. |
| GET    | `/reports/cash-flow` | AUTH+COMPANY | Cash flow statement. |
| GET    | `/reports/ar-aging` | AUTH+COMPANY | Accounts-receivable aging buckets. |
| GET    | `/reports/ap-aging` | AUTH+COMPANY | Accounts-payable aging buckets. |
| GET    | `/reports/inventory-valuation` | AUTH+COMPANY | Inventory $ on hand. |
| GET    | `/reports/tax-report` | AUTH+COMPANY | Tax collected/paid. |
| GET    | `/reports/delivery-report` | AUTH+COMPANY | Delivery KPIs. |
| GET    | `/reports/dashboard` | AUTH+COMPANY | Summary cards for home dashboard. |

### 🧾 `tax`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/tax/rates` | AUTH+COMPANY | Tax rates. |
| POST   | `/tax/rates` | AUTH+COMPANY | Create. |
| GET    | `/tax/rates/{id}` | AUTH+COMPANY | Detail. |
| PATCH  | `/tax/rates/{id}` | AUTH+COMPANY | Update. |
| DELETE | `/tax/rates/{id}` | AUTH+COMPANY | Remove. |
| GET    | `/tax/payments` | AUTH+COMPANY | Tax payments. |
| POST   | `/tax/payments` | AUTH+COMPANY | Record tax payment. |

### 🔔 `notifications` · 🔎 `audit` · ⚙️ `settings` · ❤️ `health`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET    | `/notifications` | AUTH | User's notifications. |
| GET    | `/notifications/unread-count` | AUTH | Badge count. |
| PATCH  | `/notifications/{id}/read` | AUTH | Mark read. |
| POST   | `/notifications/read-all` | AUTH | Mark all read. |
| GET    | `/audit` | AUTH+COMPANY | Audit log. Filters: userId, resourceType, dateFrom/To. |
| GET    | `/audit/summary` | AUTH+COMPANY | Counts per action. |
| GET    | `/audit/resource/{type}/{id}` | AUTH+COMPANY | Full trail for one resource. |
| GET    | `/settings` | AUTH+COMPANY | Company preferences. |
| PATCH  | `/settings` | AUTH+COMPANY | Update. |
| GET    | `/health` | public | Liveness. `200 ok`. |
| GET    | `/health/db` | public | DB probe. |
| GET    | `/health/ready` | public | Full readiness (DB + memory + disk). |

Complete machine-readable list: `@/home/muhammad-waleed-hassan/FinMatrix-Backend/FinMatrix-Backend/docs/endpoints.txt`.

---

## 4. Common request/response shapes

### 4.1 Pagination

Most `GET` collection endpoints accept:
- `?page=1` (1-indexed)
- `?limit=20` (default 20, max 100)
- `?search=text` (substring match on name/code-like fields, module-dependent)
- `?sortBy=createdAt&sortOrder=desc`

Response:
```json
{
  "success": true,
  "data": {
    "items": [...],
    "total": 127,
    "page": 1,
    "limit": 20,
    "totalPages": 7
  }
}
```

### 4.2 Validation error
HTTP `400 Bad Request`:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "field": "email", "message": "email must be an email" },
      { "field": "password", "message": "password must be at least 8 characters" }
    ]
  }
}
```

### 4.3 Auth errors
| HTTP | When |
|---|---|
| `401 Unauthorized` | No / invalid / expired access token. Frontend should attempt refresh once. |
| `403 Forbidden` | Authenticated but lacks role/company membership. Don't retry. |
| `404 Not Found` | Resource doesn't exist **or** belongs to a company the user isn't in. |
| `409 Conflict` | Duplicate unique key (email, invoice number, etc). |
| `429 Too Many Requests` | Rate limit. Response has `Retry-After` header. |
| `500 Internal Server Error` | Unhandled. Report to backend team with `error.requestId`. |

---

## 5. Frontend integration checklist

- [ ] Set `VITE_API_BASE_URL=https://finmatrix-api.onrender.com/api/v1` (or `http://localhost:3000/api/v1`).
- [ ] Add an axios/fetch interceptor that injects `Authorization: Bearer <accessToken>` and `x-company-id: <activeCompanyId>` on every request.
- [ ] On `401`, call `/auth/refresh-token` exactly once, retry the original request. If that also fails, redirect to login.
- [ ] Store `refreshToken` in `httpOnly` cookie (best) or `localStorage` (simpler). Never expose it to third-party scripts.
- [ ] Handle `429` with exponential backoff using the `Retry-After` header.
- [ ] Don't hardcode any IDs — use `GET /auth/me` to resolve `user.id` and `companies[]`.
- [ ] For PDFs (`GET /invoices/{id}/pdf`) use `responseType: 'blob'` then `URL.createObjectURL(blob)`.
- [ ] When `EMAIL_ENABLED=false` on the backend, `/auth/forgot-password` still returns 200 but sends no email; ask backend team to enable SMTP when you're ready to test it.

---

## 6. Support matrix

| Browser | Min version |
|---|---|
| Chrome / Edge | 100+ |
| Firefox | 100+ |
| Safari | 15+ |

CORS is locked down to the exact origins listed in `CORS_ORIGINS`. If you hit a CORS error, ask backend team to append your origin.

---

## 7. Changelog

Bump this doc whenever an endpoint shape changes. Breaking changes require a version bump from `api/v1` → `api/v2`.

| Date | Change |
|---|---|
| 2026-04-24 | Initial 170-endpoint reference. |
