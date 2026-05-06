# FinMatrix Backend — Frontend Integration Guide

> **Base URL:** `https://finmatrix-api-a824f23fbd72.herokuapp.com/api/v1`
> **Swagger:** `https://finmatrix-api-a824f23fbd72.herokuapp.com/api/docs` (if enabled in prod)
> **All responses** use envelope: `{ "success": true, "data": <payload> }` or `{ "success": false, "error": { "code": "...", "message": "..." } }`

---

## Login Credentials (MetroMatrix)

| Role | Email | Password |
|---|---|---|
| **Admin** | `waleedhassansfd@gmail.com` | `123456` |
| **DP #1** | `saim@metromatrix.com` | `123456` |
| **DP #2** | `haseeb@metromatrix.com` | `123456` |

---

## Authentication Headers

Every authenticated request must include:
```
Authorization: Bearer <accessToken>
X-Company-Id: <companyId>
```

The `companyId` is returned in the signin response under `data.user.defaultCompanyId` or `data.companies[0].id` from `/auth/me`.

---

## Newly Added Endpoints (Phases 1-4 Complete)

### Banking
*   `GET /api/v1/banking/transactions` (Global bank transaction list)
*   `POST /api/v1/banking/transfers` (Create dual transaction/JE transfer)
*   `GET /api/v1/banking/reconciliations/unreconciled` (List pending transactions)
*   `POST /api/v1/banking/reconciliations` (Clear/reconcile specific IDs)

### Sales & Purchasing
*   `POST /api/v1/sales-orders` (Create Sales Order)
*   `POST /api/v1/estimates` (Create Estimate)
*   `POST /api/v1/purchase-orders` (Create PO)
*   `POST /api/v1/purchase-orders/:id/receive` (Receive PO into Inventory)
*   `POST /api/v1/credit-memos` (Create Credit Memo)
*   `POST /api/v1/credit-memos/:id/apply` (Apply Credit Memo)
*   `POST /api/v1/credit-memos/:id/refund` (Refund Credit Memo)
*   `POST /api/v1/bill-payments` (Pay Bills for AP)

### Operations & HR
*   `POST /api/v1/employees` (Register Employee)
*   `GET /api/v1/payroll/worksheet` (Get active employee payroll worksheet)
*   `POST /api/v1/payroll/runs` (Create Payroll Run)
*   `POST /api/v1/tax/rates` (Create Tax Rate)
*   `POST /api/v1/tax/payments` (Record Tax Payment)
*   `GET /api/v1/tax/liability` (Get Tax Liability)
*   `POST /api/v1/agencies/:id/inventory` (Assign Inventory to Agency)
*   `POST /api/v1/agencies/:id/sync-inventory` (Sync Agency Inventory)

### Reports & Auth
*   `GET /api/v1/reports/budget-comparison`
*   `GET /api/v1/reports/delivery-daily`
*   `GET /api/v1/reports/delivery-performance`
*   `GET /api/v1/reports/sales-by-customer`
*   `GET /api/v1/reports/sales-by-item`
*   `GET /api/v1/reports/analytics-dashboard`
*   `GET /api/v1/budgets`
*   `POST /api/v1/budgets`
*   `POST /api/v1/auth/verify-email`
*   `POST /api/v1/auth/resend-verification`
*   `GET /api/v1/auth/check-verification`

---

## 1. Auth

### POST `/auth/signin`
```json
// Request
{ "email": "waleedhassansfd@gmail.com", "password": "123456" }

// Response 200
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "waleedhassansfd@gmail.com",
      "displayName": "Waleed Hassan",
      "role": "admin",
      "phone": "+92-300-1234567",
      "defaultCompanyId": "uuid"
    },
    "tokens": {
      "accessToken": "eyJ...",
      "refreshToken": "eyJ...",
      "expiresIn": 900
    }
  }
}
```

### POST `/auth/signup`
```json
// Request (admin)
{
  "email": "new@admin.com",
  "password": "SecurePass123!",
  "displayName": "New Admin",
  "role": "admin",
  "phone": "+92-300-0000000"
}

// Request (delivery — needs company invite code)
{
  "email": "dp@company.com",
  "password": "SecurePass123!",
  "displayName": "New DP",
  "role": "delivery",
  "companyCode": "ABC123"
}
```

### POST `/auth/refresh-token`
```json
{ "refreshToken": "eyJ..." }
```

### GET `/auth/me` — Auth required
Returns user profile + company memberships with invite codes.

### POST `/auth/signout` — Auth required
Revokes all refresh tokens.

### POST `/auth/forgot-password`
```json
{ "email": "user@example.com" }
```

### POST `/auth/reset-password`
```json
{ "token": "hex-token-from-logs", "password": "NewPassword123!" }
```

---

## 2. Companies

### GET `/companies` — List user's companies
### GET `/companies/:id` — Company detail
### PATCH `/companies/:id` — Update company
### GET `/companies/:id/invite-code` — Get invite code
### POST `/companies/:id/regenerate-invite` — Regenerate invite code

---

## 3. Customers

### GET `/customers` — List (paginated, search, filter by active)
```
GET /customers?page=1&limit=20&search=tariq&isActive=true
```

### POST `/customers` — Create
```json
{
  "name": "New Store",
  "email": "store@gmail.com",
  "phone": "+92-300-0000000",
  "billingAddress": { "city": "Lahore", "country": "Pakistan" },
  "creditLimit": "50000",
  "paymentTerms": "net30"
}
```

### GET `/customers/:id` — Detail
### PATCH `/customers/:id` — Update

---

## 4. Vendors

### GET `/vendors` — List
### POST `/vendors` — Create
```json
{
  "companyName": "New Supplier",
  "contactPerson": "Mr. Ahmad",
  "email": "supplier@vendor.pk",
  "phone": "+92-42-1234567",
  "paymentTerms": "net30"
}
```
### GET `/vendors/:id` — Detail
### PATCH `/vendors/:id` — Update

---

## 5. Inventory

### GET `/inventory/items` — List items
```
GET /inventory/items?page=1&limit=20&category=Cooking+Oil&search=habib
```

### POST `/inventory/items` — Create item
```json
{
  "sku": "NEW-SKU-001",
  "name": "New Product",
  "category": "Cooking Oil",
  "unitOfMeasure": "bottle",
  "unitCost": "1500",
  "sellingPrice": "1800",
  "quantityOnHand": "200",
  "reorderPoint": "50",
  "reorderQuantity": "100"
}
```

### GET `/inventory/items/:id` — Detail
### PATCH `/inventory/items/:id` — Update
### PATCH `/inventory/items/:id/toggle` — Activate/deactivate
### GET `/inventory/items/:id/movements` — Stock movement history
### POST `/inventory/items/:id/adjust` — Manual qty adjustment
```json
{
  "adjustmentQty": "-10",
  "reason": "Damaged items removed"
}
```
### GET `/inventory/movements` — All movements (filterable)
### POST `/inventory/transfers` — Stock transfer
### PATCH `/inventory/transfers/:id/complete` — Complete transfer
### POST `/inventory/physical-counts` — Submit physical count

---

## 6. Deliveries

### GET `/deliveries` — List all (admin)
```
GET /deliveries?status=in_transit&page=1&limit=20
```

### POST `/deliveries` — Create delivery
```json
{
  "customerId": "uuid",
  "personnelId": "uuid-or-null",
  "priority": "high",
  "preferredDate": "2026-04-30",
  "preferredTimeSlot": "09:00-12:00",
  "notes": "Fragile items",
  "items": [
    { "itemId": "uuid", "orderedQty": "50", "unitPrice": "480" }
  ]
}
```

### GET `/deliveries/:id` — Detail (with items)
### PATCH `/deliveries/:id` — Update
### PATCH `/deliveries/:id/status` — Change status
```json
{ "status": "in_transit" }
```
Statuses: `unassigned → pending → picked_up → in_transit → arrived → delivered | failed | returned | cancelled`

### POST `/deliveries/:id/auto-assign` — Auto-assign driver
### GET `/deliveries/:id/history` — Status change history
### GET `/deliveries/:id/issues` — Reported issues
### POST `/deliveries/:id/issues` — Report issue
### GET `/deliveries/my/assigned` — DP's own assignments (delivery role)

---

## 7. Bill Photo Capture & Inventory Approval ⭐ NEW

### POST `/deliveries/:deliveryId/bill-photo` — Upload bill photo (DP role)
**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `photo` | file | ✅ | JPEG/PNG/WebP, max 8 MB |
| `signedBy` | string | ✅ | Customer name on signed bill |
| `source` | string | ✅ | `"camera"` or `"gallery"` |
| `note` | string | ❌ | Optional note |
| `changes` | string | ✅ | JSON array (stringified) |

**`changes` format:**
```json
[
  {
    "itemId": "uuid",
    "itemName": "Habib Cooking Oil 5L",
    "beforeQty": 450,
    "deliveredQty": 48,
    "returnedQty": 2
  }
]
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "requestId": "uuid",
    "deliveryId": "uuid",
    "photoUrl": "/storage/bill-photos/...",
    "uploadedAt": "2026-04-29T08:35:00.000Z"
  }
}
```

**Errors:** `400` missing fields, `403` not your delivery, `404` not found, `409` duplicate, `413` >8MB, `415` wrong mimetype

---

### GET `/inventory-update-requests` — List requests (admin)
```
GET /inventory-update-requests?status=pending&page=1&pageSize=20
```

**Response:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "deliveryId": "uuid",
        "deliveryReference": "DEL-A1B2C3D4",
        "personnelId": "uuid",
        "personnelName": "Saim Raza",
        "routeLabel": "Route · 2026-04-29",
        "submittedAt": "2026-04-29T08:35:00.000Z",
        "status": "pending",
        "shadowStatus": "pending",
        "reviewedAt": null,
        "reviewedBy": null,
        "reviewerComment": null,
        "changes": [
          {
            "itemId": "uuid",
            "itemName": "Habib Cooking Oil 5L",
            "beforeQty": 450,
            "deliveredQty": 48,
            "returnedQty": 2
          }
        ],
        "proof": {
          "signatureBase64": "",
          "signedBy": "Muhammad Arif",
          "verificationMethod": "bill_photo",
          "verifiedBy": "Saim Raza",
          "verifiedAt": "2026-04-29T08:35:00.000Z",
          "billPhotoUri": "/storage/bill-photos/...",
          "billPhotoCapturedAt": "2026-04-29T08:35:00.000Z"
        }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

### GET `/inventory-update-requests/:id` — Single request detail
Same shape as list items. Accessible to admin or owning DP.

### POST `/inventory-update-requests/:id/approve` — Approve (admin)
```json
{ "reviewerComment": "Looks good, approved." }
```
**Response:** Updated request with `status: "approved"`, `shadowStatus: "synced"`.
Real inventory is mutated. `409` if not pending. `422` if negative stock.

### POST `/inventory-update-requests/:id/reject` — Reject (admin)
```json
{ "reviewerComment": "Photo is blurry, please re-submit." }
```
**Response:** Updated request with `status: "rejected"`. No inventory mutation.

### GET `/inventory-update-requests/:id/bill-photo` — Stream photo
Returns raw image (`image/jpeg`). Use directly as `<img src="...">`.

---

## 8. Delivery Personnel

### GET `/delivery-personnel` — List drivers
### POST `/delivery-personnel` — Onboard driver
### GET `/delivery-personnel/:userId` — Driver profile
### PATCH `/delivery-personnel/:userId` — Update profile
### PATCH `/delivery-personnel/:userId/availability` — Toggle availability

---

## 9. Shadow Inventory (DP mobile app)

### GET `/shadow-inventory` — DP's offline inventory snapshot
### POST `/shadow-inventory` — Save snapshot
### PATCH `/shadow-inventory/:id` — Update
### POST `/shadow-inventory/sync/:personnelId` — Sync from central

---

## 10. Agencies

### GET `/agencies` — List
### POST `/agencies` — Add agency
### GET `/agencies/:id` — Detail
### PATCH `/agencies/:id` — Update
### PATCH `/agencies/:id/connected` — Toggle connection
### DELETE `/agencies/:id` — Remove

---

## 11. Notifications

### GET `/notifications` — List user's notifications
### PATCH `/notifications/:id/read` — Mark as read
### PATCH `/notifications/read-all` — Mark all as read

---

## 12. Accounting (Invoices, Bills, Payments)

### Invoices
| Method | Path | Purpose |
|---|---|---|
| GET | `/invoices` | List invoices |
| POST | `/invoices` | Create invoice |
| GET | `/invoices/:id` | Detail |
| PATCH | `/invoices/:id` | Update |
| PATCH | `/invoices/:id/status` | Change status |
| GET | `/invoices/:id/pdf` | Download PDF |

### Bills
| Method | Path | Purpose |
|---|---|---|
| GET | `/bills` | List bills |
| POST | `/bills` | Create bill |
| GET | `/bills/:id` | Detail |
| PATCH | `/bills/:id` | Update |

### Payments
| Method | Path | Purpose |
|---|---|---|
| GET | `/payments` | List |
| POST | `/payments` | Record payment |
| GET | `/payments/:id` | Detail |

### Accounts / Ledger / Journal Entries
| Method | Path | Purpose |
|---|---|---|
| GET | `/accounts` | Chart of accounts |
| GET | `/ledger/:accountId` | Ledger entries |
| GET | `/journal-entries` | List JEs |
| POST | `/journal-entries` | Create manual JE |

---

## 13. Reports & Dashboard

### GET `/reports/dashboard` — Dashboard KPIs
### GET `/reports/profit-loss` — P&L report
### GET `/reports/balance-sheet` — Balance sheet
### GET `/reports/trial-balance` — Trial balance
### GET `/reports/cash-flow` — Cash flow
### GET `/reports/aging` — AR/AP aging

---

## Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/invalid fields |
| 401 | `INVALID_CREDENTIALS` | Wrong email/password |
| 401 | `INVALID_TOKEN` | Expired/revoked JWT |
| 403 | `FORBIDDEN` | Not authorized for this resource |
| 404 | `NOT_FOUND` | Resource doesn't exist |
| 409 | `CONFLICT` | Duplicate/already processed |
| 413 | `PAYLOAD_TOO_LARGE` | File exceeds size limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Wrong file type |
| 422 | `NEGATIVE_STOCK` | Would drive inventory below zero |
| 429 | `TOO_MANY_REQUESTS` | Rate limited |

---

## Quick Start for Frontend

```bash
# 1. Make sure PostgreSQL is running
docker compose up -d postgres

# 2. Run migrations
cd FinMatrix-Backend
npm run migration:run

# 3. Seed MetroMatrix data
npm run seed:metromatrix

# 4. Start the backend
npm run start:dev

# 5. Test signin
curl -X POST http://localhost:3000/api/v1/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"waleedhassansfd@gmail.com","password":"123456"}'
```

The response will contain `accessToken` and `user.defaultCompanyId`. Use these for all subsequent requests.
