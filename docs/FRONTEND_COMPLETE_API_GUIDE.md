# FinMatrix Backend — Complete Frontend API Integration Guide

> **Production Base URL:** `https://finmatrix-api-a824f23fbd72.herokuapp.com/api/v1`
> **Local Dev URL:** `http://localhost:3000/api/v1`
> **Total APIs:** 148 (Module 1: 77 + Module 2: 71)

---

## Global Rules

### Authentication
Every authenticated request **MUST** include:
```
Authorization: Bearer <accessToken>
x-company-id: <companyId>
```

### Response Envelope
```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

### Pagination (all list endpoints)
Query: `?page=1&limit=20`
Response includes: `{ data: [...], total: N, page: 1, limit: 20 }`

### Auth Types
| Type | Description |
|------|-------------|
| **Public** | No token required |
| **User Auth** | Any authenticated user with valid JWT |
| **Admin Auth** | JWT with `role='admin'` |
| **Delivery Auth** | JWT with `role='delivery'` |

### Login Credentials (Seeded Data)
| Role | Email | Password |
|------|-------|----------|
| Admin | `waleedhassansfd@gmail.com` | `123456` |
| DP #1 | `saim@metromatrix.com` | `123456` |
| DP #2 | `haseeb@metromatrix.com` | `123456` |
| Company Invite Code | `8TKXWK` | — |

---

# MODULE 1: Authentication, Core Accounting & Transactions

---

## 1. Authentication & Authorization (14 APIs)
**Base path:** `/auth` and `/companies`

### 1.1 Sign Up
```
POST /auth/signup                                    Public
```
**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "displayName": "Muhammad Ali",
  "phone": "+92-300-1234567",
  "role": "admin"
}
```
**Notes:**
- `role`: `"admin"` or `"delivery"`
- For delivery role, also send: `vehicleType`, `vehicleNumber`, `zones`, `companyCode`

**Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "Muhammad Ali",
      "role": "admin",
      "companyId": null,
      "defaultCompanyId": null
    },
    "tokens": {
      "accessToken": "eyJ...",
      "refreshToken": "eyJ...",
      "expiresIn": 900
    },
    "companyId": null,
    "company": null
  }
}
```

### 1.2 Sign In
```
POST /auth/signin                                    Public
```
**Request:**
```json
{
  "email": "waleedhassansfd@gmail.com",
  "password": "123456"
}
```
**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "waleedhassansfd@gmail.com",
      "displayName": "Waleed Hassan",
      "role": "admin",
      "phone": "+92-300-1234567",
      "companyId": "company-uuid",
      "defaultCompanyId": "company-uuid"
    },
    "tokens": {
      "accessToken": "eyJ...",
      "refreshToken": "eyJ...",
      "expiresIn": 900
    },
    "companyId": "company-uuid",
    "company": {
      "id": "company-uuid",
      "name": "MetroMatrix"
    }
  }
}
```

### 1.3 Forgot Password
```
POST /auth/forgot-password                           Public
```
**Request:** `{ "email": "user@example.com" }`
**Response (200):** `{ "success": true, "message": "Password reset link sent to your email" }`

### 1.4 Reset Password
```
POST /auth/reset-password                            Public
```
**Request:** `{ "token": "reset_token", "newPassword": "NewSecure123!" }`
**Response (200):** `{ "success": true, "message": "Password reset successfully" }`

### 1.5 Refresh Token
```
POST /auth/refresh-token                             Public
```
**Request:** `{ "refreshToken": "eyJ..." }`
**Response (200):**
```json
{
  "success": true,
  "data": {
    "accessToken": "new_token...",
    "refreshToken": "new_refresh...",
    "expiresIn": 900
  }
}
```

### 1.6 Get Current User (Me)
```
GET /auth/me                                         User Auth
```
**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "waleedhassansfd@gmail.com",
      "displayName": "Waleed Hassan",
      "role": "admin",
      "phone": "+92-300-1234567",
      "companyId": "company-uuid",
      "defaultCompanyId": "company-uuid"
    },
    "companies": [
      {
        "id": "company-uuid",
        "name": "MetroMatrix",
        "role": "admin",
        "inviteCode": "8TKXWK"
      }
    ],
    "companyId": "company-uuid",
    "company": { "id": "company-uuid", "name": "MetroMatrix" }
  }
}
```

### 1.7 Sign Out
```
POST /auth/signout                                   User Auth
```
**Response (200):** `{ "success": true, "message": "Signed out successfully" }`

### 1.8 Create Company
```
POST /companies                                      User Auth
```
**Request:**
```json
{
  "name": "Ali Traders",
  "industry": "Distribution",
  "address": "123 Main Street, Lahore",
  "phone": "+92-42-1234567",
  "email": "contact@alitraders.pk",
  "taxId": "1234567-8"
}
```
**Response (201):** Returns created company with auto-generated `inviteCode`.

### 1.9 Join Company
```
POST /companies/join                                 User Auth
```
**Request:** `{ "inviteCode": "ABC123" }`
**Response (200):** `{ "company": { "companyId": "...", "name": "..." }, "role": "delivery" }`

### 1.10 Get Company Details
```
GET /companies/:companyId                            User Auth
```

### 1.11 Update Company
```
PATCH /companies/:companyId                          Admin Auth
```

### 1.12 Get Company Members
```
GET /companies/:companyId/members                    Admin Auth
```

### 1.13 Remove Member
```
DELETE /companies/:companyId/members/:userId          Admin Auth
```

### 1.14 Regenerate Invite Code
```
POST /companies/:companyId/regenerate-code           Admin Auth
```

---

## 2. Chart of Accounts (6 APIs)
**Base path:** `/accounts`
**Header required:** `x-company-id`

### 2.1 Get All Accounts
```
GET /accounts                                        User Auth
```
**Query:** `?type=asset&subType=Cash&search=cash&isActive=true&page=1&limit=50`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "accounts": [
      {
        "id": "uuid",
        "accountNumber": "1000",
        "name": "Cash",
        "type": "asset",
        "subType": "Cash",
        "parentId": null,
        "description": "Cash on hand",
        "balance": 34200,
        "isActive": true,
        "createdAt": "2024-01-01T00:00:00Z"
      }
    ],
    "summary": {
      "assets": { "count": 10, "totalBalance": 350000 },
      "liabilities": { "count": 5, "totalBalance": 95000 },
      "equity": { "count": 3, "totalBalance": 255000 },
      "revenue": { "count": 4, "totalBalance": 0 },
      "expenses": { "count": 15, "totalBalance": 0 }
    },
    "total": 37, "page": 1, "limit": 50
  }
}
```

### 2.2 Get Account Detail
```
GET /accounts/:accountId                             User Auth
```

### 2.3 Create Account
```
POST /accounts                                       Admin Auth
```
**Request:**
```json
{
  "accountNumber": "6600",
  "name": "Marketing Expenses",
  "type": "expense",
  "subType": "Operating",
  "parentId": null,
  "description": "Marketing costs",
  "openingBalance": 0,
  "isActive": true
}
```

**Account Types & Sub-Types:**
- **Asset:** Cash, Bank, Accounts Receivable, Inventory, Prepaid, Fixed Asset, Other Asset
- **Liability:** Accounts Payable, Credit Card, Payroll Liability, Tax Payable, Notes Payable, Other Liability
- **Equity:** Owner Equity, Retained Earnings, Owner Draws, Other Equity
- **Revenue:** Sales, Service, Interest, Other Revenue
- **Expense:** Cost of Goods, Operating, Payroll, Tax, Depreciation, Other Expense

### 2.4 Update Account
```
PATCH /accounts/:accountId                           Admin Auth
```

### 2.5 Toggle Account Active
```
PATCH /accounts/:accountId/toggle                    Admin Auth
```

### 2.6 Get Account Transactions
```
GET /accounts/:accountId/transactions                User Auth
```
**Query:** `?page=1&limit=20`

---

## 3. General Ledger (1 API)
**Base path:** `/ledger`

### 3.1 Get Ledger Entries
```
GET /ledger                                          User Auth
```
**Query:** `?startDate=2024-01-01&endDate=2024-01-31&accountId=uuid&page=1&limit=100`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "entries": [
      {
        "id": "uuid",
        "date": "2024-01-15",
        "reference": "JE-001",
        "description": "Office rent",
        "accountId": "uuid",
        "accountNumber": "6000",
        "accountName": "Rent Expense",
        "debit": 25000,
        "credit": 0,
        "balance": 25000,
        "sourceType": "journal_entry",
        "sourceId": "uuid"
      }
    ],
    "totals": { "totalDebits": 150000, "totalCredits": 150000, "isBalanced": true },
    "total": 250, "page": 1, "limit": 100
  }
}
```

---

## 4. Journal Entries (7 APIs)
**Base path:** `/journal-entries`

### 4.1 Get All Journal Entries
```
GET /journal-entries                                 User Auth
```
**Query:** `?status=posted&startDate=2024-01-01&endDate=2024-01-31&search=rent&page=1&limit=20`

### 4.2 Get Journal Entry Detail
```
GET /journal-entries/:entryId                        User Auth
```

### 4.3 Create Journal Entry
```
POST /journal-entries                                Admin Auth
```
**Request:**
```json
{
  "date": "2024-01-15",
  "reference": "JE-001",
  "memo": "Monthly rent",
  "lines": [
    { "accountId": "acc_6000", "description": "Rent", "debit": 25000, "credit": 0 },
    { "accountId": "acc_1000", "description": "Cash", "debit": 0, "credit": 25000 }
  ],
  "status": "draft"
}
```
**Validation:** Min 2 lines. Each line: debit > 0 OR credit > 0 (not both). For posting: debits == credits.

### 4.4 Update Journal Entry
```
PATCH /journal-entries/:entryId                      Admin Auth
```
Only `draft` entries can be updated.

### 4.5 Post Journal Entry
```
POST /journal-entries/:entryId/post                  Admin Auth
```
Changes draft → posted. Updates account balances.

### 4.6 Void Journal Entry
```
POST /journal-entries/:entryId/void                  Admin Auth
```
**Request:** `{ "reason": "Duplicate entry" }`
Creates reversing entry, marks original void.

### 4.7 Duplicate Journal Entry
```
POST /journal-entries/:entryId/duplicate             Admin Auth
```
Creates copy as new draft with today's date.

---

## 5. Customers (7 APIs)
**Base path:** `/customers`

### 5.1 Get All Customers
```
GET /customers                                       User Auth
```
**Query:** `?search=ahmed&isActive=true&hasBalance=true&sortBy=balance&sortOrder=desc&page=1&limit=20`

### 5.2 Get Customer Detail
```
GET /customers/:customerId                           User Auth
```

### 5.3 Create Customer
```
POST /customers                                      Admin Auth
```
**Request:**
```json
{
  "name": "Muhammad Ahmed",
  "company": "ABC Corporation",
  "email": "ahmed@abc.com",
  "phone": "+92-42-1234567",
  "billingAddress": { "street": "123 Business Ave", "city": "Lahore", "state": "Punjab", "zip": "54000" },
  "shippingAddress": { "sameAsBilling": true },
  "creditLimit": 100000,
  "paymentTerms": "net30",
  "notes": "VIP customer"
}
```
**Payment Terms:** `due_on_receipt`, `net15`, `net30`, `net45`, `net60`, `2_10_net30`

### 5.4 Update Customer
```
PATCH /customers/:customerId                         Admin Auth
```

### 5.5 Get Customer Invoices
```
GET /customers/:customerId/invoices                  User Auth
```

### 5.6 Get Customer Payments
```
GET /customers/:customerId/payments                  User Auth
```

### 5.7 Get Customer Statement
```
GET /customers/:customerId/statement                 User Auth
```
**Query:** `?startDate=2024-01-01&endDate=2024-01-31`

---

## 6. Invoices (7 APIs)
**Base path:** `/invoices`

### 6.1 Get All Invoices
```
GET /invoices                                        User Auth
```
**Query:** `?status=partial&customerId=uuid&startDate=2024-01-01&endDate=2024-01-31&search=INV&page=1&limit=20`

### 6.2 Get Invoice Detail
```
GET /invoices/:invoiceId                             User Auth
```

### 6.3 Create Invoice
```
POST /invoices                                       Admin Auth
```
**Request:**
```json
{
  "customerId": "uuid",
  "invoiceDate": "2024-01-15",
  "dueDate": "2024-02-14",
  "lineItems": [
    { "description": "Product A", "quantity": 10, "unitPrice": 500, "taxRate": 15, "accountId": "acc_4000" }
  ],
  "discount": { "type": "percentage", "value": 5 },
  "notes": "Thank you",
  "paymentTerms": "net30",
  "status": "draft"
}
```
**Auto Journal Entry** (when sent): DR Accounts Receivable, CR Sales Revenue + Sales Tax.

### 6.4 Update Invoice
```
PATCH /invoices/:invoiceId                           Admin Auth
```
Only `draft` invoices.

### 6.5 Send Invoice
```
POST /invoices/:invoiceId/send                       Admin Auth
```
Status → `sent`. Creates journal entry.

### 6.6 Void Invoice
```
POST /invoices/:invoiceId/void                       Admin Auth
```
**Request:** `{ "reason": "Customer cancelled" }`

### 6.7 Get Invoice PDF
```
GET /invoices/:invoiceId/pdf                         User Auth
```
Returns `application/pdf`. Use `responseType: 'blob'`.

---

## 7. Payments (4 APIs)
**Base path:** `/payments`

### 7.1 Receive Customer Payment
```
POST /payments                                       Admin Auth
```
**Request:**
```json
{
  "customerId": "uuid",
  "paymentDate": "2024-01-20",
  "paymentMethod": "bank_transfer",
  "reference": "TRF-12345",
  "amount": 10000,
  "bankAccountId": "bank_001",
  "memo": "January payment",
  "applications": [
    { "invoiceId": "inv_001", "amount": 5750 },
    { "invoiceId": "inv_002", "amount": 4250 }
  ]
}
```
**Payment Methods:** `cash`, `check`, `bank_transfer`, `credit_card`, `other`

### 7.2 Get Customer Outstanding Invoices
```
GET /payments/customer/:customerId/outstanding       User Auth
```

### 7.3 Get Payment History
```
GET /payments                                        User Auth
```
**Query:** `?customerId=uuid&startDate=2024-01-01&endDate=2024-01-31&page=1&limit=20`

### 7.4 Get Payment Detail
```
GET /payments/:paymentId                             User Auth
```

---

## 8. Estimates (5 APIs)
**Base path:** `/estimates`

### 8.1 Get All Estimates
```
GET /estimates                                       User Auth
```
**Query:** `?status=sent&customerId=uuid&page=1&limit=20`

### 8.2 Get Estimate Detail
```
GET /estimates/:estimateId                           User Auth
```

### 8.3 Create Estimate
```
POST /estimates                                      Admin Auth
```
**Request:**
```json
{
  "customerId": "uuid",
  "estimateDate": "2024-01-15",
  "expirationDate": "2024-01-30",
  "lineItems": [
    { "description": "Product A", "quantity": 10, "unitPrice": 500, "taxRate": 15 }
  ],
  "discount": { "type": "percentage", "value": 5 },
  "notes": "Valid for 15 days"
}
```

### 8.4 Update Estimate
```
PATCH /estimates/:estimateId                         Admin Auth
```

### 8.5 Convert Estimate to Invoice
```
POST /estimates/:estimateId/convert-to-invoice       Admin Auth
```
Creates invoice, estimate status → `accepted`.

---

## 9. Sales Orders (5 APIs)
**Base path:** `/sales-orders`

### 9.1 Get All Sales Orders
```
GET /sales-orders                                    User Auth
```
**Query:** `?status=open&customerId=uuid&page=1&limit=20`

### 9.2 Get Sales Order Detail
```
GET /sales-orders/:orderId                           User Auth
```

### 9.3 Create Sales Order
```
POST /sales-orders                                   Admin Auth
```

### 9.4 Fulfill Items
```
POST /sales-orders/:orderId/fulfill                  Admin Auth
```
**Request:**
```json
{
  "fulfillmentDate": "2024-01-18",
  "lines": [{ "lineId": "uuid", "fulfilledQty": 60 }],
  "notes": "Partial shipment"
}
```

### 9.5 Create Invoice from Sales Order
```
POST /sales-orders/:orderId/create-invoice           Admin Auth
```

---

## 10. Credit Memos (3 APIs)
**Base path:** `/credit-memos`

### 10.1 Get All Credit Memos
```
GET /credit-memos                                    User Auth
```

### 10.2 Create Credit Memo
```
POST /credit-memos                                   Admin Auth
```
**Request:**
```json
{
  "customerId": "uuid",
  "date": "2024-01-20",
  "originalInvoiceId": "inv_001",
  "reason": "Product return",
  "lineItems": [
    { "description": "Returned Product A", "quantity": 2, "unitPrice": 500, "taxRate": 15 }
  ]
}
```

### 10.3 Apply Credit to Invoice
```
POST /credit-memos/:creditId/apply                   Admin Auth
```
**Request:** `{ "invoiceId": "inv_002", "amount": 1150 }`

---

## 11. Vendors (6 APIs)
**Base path:** `/vendors`

### 11.1 Get All Vendors
```
GET /vendors                                         User Auth
```
**Query:** `?search=dalda&isActive=true&page=1&limit=20`

### 11.2 Get Vendor Detail
```
GET /vendors/:vendorId                               User Auth
```

### 11.3 Create Vendor
```
POST /vendors                                        Admin Auth
```
**Request:**
```json
{
  "companyName": "Dalda Foods",
  "contactPerson": "Ahmad Khan",
  "email": "ahmad@dalda.com",
  "phone": "+92-42-9876543",
  "address": { "street": "...", "city": "Karachi", "state": "Sindh" },
  "paymentTerms": "net30",
  "taxId": "1234567-8",
  "defaultExpenseAccountId": "acc_5000"
}
```

### 11.4 Update Vendor
```
PATCH /vendors/:vendorId                             Admin Auth
```

### 11.5 Get Vendor Bills
```
GET /vendors/:vendorId/bills                         User Auth
```

### 11.6 Get Vendor Payments
```
GET /vendors/:vendorId/payments                      User Auth
```

---

## 12. Bills (4 APIs)
**Base path:** `/bills`

### 12.1 Get All Bills
```
GET /bills                                           User Auth
```
**Query:** `?status=open&vendorId=uuid&startDate=2024-01-01&endDate=2024-01-31&page=1&limit=20`

### 12.2 Create Bill
```
POST /bills                                          Admin Auth
```
**Request:**
```json
{
  "vendorId": "uuid",
  "billNumber": "VEND-INV-001",
  "billDate": "2024-01-15",
  "dueDate": "2024-02-14",
  "lineItems": [
    { "accountId": "acc_6100", "description": "Utilities", "amount": 15000, "taxRate": 0 }
  ],
  "memo": "January bill"
}
```

### 12.3 Update Bill
```
PATCH /bills/:billId                                 Admin Auth
```

### 12.4 Pay Bills
```
POST /bills/pay                                      Admin Auth
```
**Request:**
```json
{
  "bankAccountId": "bank_001",
  "paymentDate": "2024-01-20",
  "paymentMethod": "check",
  "reference": "CHK-1001",
  "payments": [
    { "billId": "bill_001", "amount": 15000 }
  ]
}
```

---

## 13. Purchase Orders (5 APIs)
**Base path:** `/purchase-orders`

### 13.1 Get All Purchase Orders
```
GET /purchase-orders                                 User Auth
```
**Query:** `?status=partial&vendorId=uuid&page=1&limit=20`

### 13.2 Get Purchase Order Detail
```
GET /purchase-orders/:poId                           User Auth
```

### 13.3 Create Purchase Order
```
POST /purchase-orders                                Admin Auth
```
**Request:**
```json
{
  "vendorId": "uuid",
  "orderDate": "2024-01-15",
  "expectedDate": "2024-01-22",
  "lineItems": [
    { "itemId": "uuid", "orderedQty": 100, "unitCost": 100, "taxRate": 15 }
  ],
  "notes": "Urgent"
}
```

### 13.4 Receive Items
```
POST /purchase-orders/:poId/receive                  Admin Auth
```
**Request:**
```json
{
  "receiveDate": "2024-01-18",
  "lines": [{ "lineId": "uuid", "receivedQty": 60 }],
  "notes": "Partial"
}
```

### 13.5 Convert to Bill
```
POST /purchase-orders/:poId/create-bill              Admin Auth
```

---

## 14. Vendor Credits (3 APIs)
**Base path:** `/vendor-credits`

### 14.1 Get All Vendor Credits
```
GET /vendor-credits                                  User Auth
```

### 14.2 Create Vendor Credit
```
POST /vendor-credits                                 Admin Auth
```
**Request:**
```json
{
  "vendorId": "uuid",
  "date": "2024-01-20",
  "originalBillId": "bill_001",
  "reason": "Returned damaged goods",
  "lineItems": [
    { "accountId": "acc_1200", "description": "Returned Product A", "amount": 5000 }
  ]
}
```

### 14.3 Apply Credit to Bill
```
POST /vendor-credits/:creditId/apply                 Admin Auth
```
**Request:** `{ "billId": "bill_002", "amount": 5000 }`

---

# MODULE 2: Inventory, Delivery Management & Operations

---

## 1. Delivery Personnel Management (6 APIs)
**Base path:** `/delivery-personnel`

### 1.1 Get All Delivery Personnel
```
GET /delivery-personnel                              Admin Auth
```
**Query:** `?status=active&page=1&limit=20`

### 1.2 Create Delivery Personnel (Quick Add)
```
POST /delivery-personnel                             Admin Auth
```
**Request:**
```json
{
  "userId": "uuid",
  "displayName": "New Personnel",
  "vehicleType": "motorcycle",
  "vehicleNumber": "LHR-9999",
  "zones": ["Zone A", "Zone C"],
  "maxLoad": 15
}
```

### 1.3 Get Personnel Detail
```
GET /delivery-personnel/:userId                      Admin Auth
```

### 1.4 Update Personnel
```
PATCH /delivery-personnel/:userId                    Admin Auth
```

### 1.5 Toggle Personnel Availability
```
PATCH /delivery-personnel/:userId/availability       Admin Auth
```

### 1.6 Reset Personnel Password
```
POST /delivery-personnel/:userId/reset-password      Admin Auth
```
**Response:**
```json
{
  "userId": "uuid",
  "credentials": { "email": "...", "temporaryPassword": "Del@4829" },
  "message": "Password reset. Share credentials securely."
}
```

---

## 2. Inventory Management (8 APIs)
**Base path:** `/inventory`

### 2.1 Get All Inventory Items
```
GET /inventory/items                                 User Auth
```
**Query:** `?category=Cooking+Oil&stockStatus=low_stock&agencyId=uuid&search=dalda&sortBy=quantity&page=1&limit=20`

### 2.2 Get Item Detail
```
GET /inventory/items/:id                             User Auth
```

### 2.3 Create Inventory Item
```
POST /inventory/items                                Admin Auth
```
**Request:**
```json
{
  "sku": "PROD-001",
  "name": "Product A",
  "description": "High quality",
  "category": "General",
  "unitOfMeasure": "Each",
  "costMethod": "average",
  "unitCost": 100,
  "sellingPrice": 150,
  "quantityOnHand": 100,
  "reorderPoint": 20,
  "reorderQuantity": 50,
  "sourceAgencyId": "uuid"
}
```
**Cost Methods:** `fifo`, `lifo`, `average`

### 2.4 Update Inventory Item
```
PATCH /inventory/items/:id                           Admin Auth
```

### 2.5 Adjust Stock
```
POST /inventory/items/:id/adjust                     Admin Auth
```
**Request:**
```json
{
  "newQuantity": 95,
  "reason": "damage",
  "reference": "ADJ-2024-001",
  "notes": "5 units damaged"
}
```
**Reasons:** `physical_count`, `damage`, `theft`, `return`, `received`, `other`

### 2.6 Physical Count
```
POST /inventory/physical-counts                      Admin Auth
```
**Request:**
```json
{
  "countDate": "2024-01-31",
  "counts": [
    { "itemId": "uuid", "countedQty": 148 }
  ],
  "notes": "Monthly count"
}
```

### 2.7 Stock Transfer
```
POST /inventory/transfers                            Admin Auth
```
**Request:**
```json
{
  "fromLocationId": "loc_1",
  "toLocationId": "loc_2",
  "transferDate": "2024-01-15",
  "items": [{ "itemId": "uuid", "quantity": 20 }],
  "reference": "TRF-001"
}
```

### 2.8 Get Stock Movements
```
GET /inventory/items/:id/movements                   User Auth
```
**Query:** `?page=1&limit=20`

---

## 3. Warehouse Agencies (4 APIs)
**Base path:** `/agencies`

### 3.1 Get All Agencies
```
GET /agencies                                        User Auth
```

### 3.2 Get Agency Detail
```
GET /agencies/:id                                    User Auth
```

### 3.3 Create Agency
```
POST /agencies                                       Admin Auth
```
**Request:**
```json
{
  "name": "New Agency",
  "type": "distribution",
  "description": "Eastern region partner",
  "address": { "city": "Faisalabad", "state": "Punjab" },
  "contact": { "name": "Contact", "phone": "+92-41-1234567" }
}
```
**Types:** `manufacturing`, `supply`, `distribution`

### 3.4 Sync Agency Inventory
```
POST /agencies/:id/sync-inventory                    Admin Auth
```

---

## 4. Deliveries - Admin (7 APIs)
**Base path:** `/deliveries`

### 4.1 Get All Deliveries
```
GET /deliveries                                      Admin Auth
```
**Query:** `?status=in_transit&personnelId=uuid&customerId=uuid&page=1&limit=20`

### 4.2 Create Delivery
```
POST /deliveries                                     Admin Auth
```
**Request:**
```json
{
  "customerId": "uuid",
  "personnelId": "uuid",
  "items": [
    { "itemId": "uuid", "orderedQty": "10", "unitPrice": "500" }
  ],
  "priority": "normal",
  "notes": "Handle with care",
  "preferredDate": "2024-01-16",
  "preferredTimeSlot": "morning"
}
```
**Priority:** `normal`, `high`, `urgent`

### 4.3 Assign Deliveries
```
POST /deliveries/assign                              Admin Auth
```
**Request:**
```json
{
  "deliveryIds": ["uuid1", "uuid2"],
  "personnelId": "uuid"
}
```

### 4.4 Auto-Assign Delivery
```
POST /deliveries/:id/auto-assign                     Admin Auth
```
Assigns to available personnel with lowest load.

### 4.5 Get Delivery Detail
```
GET /deliveries/:id                                  Admin Auth
```

### 4.6 Re-assign / Update Delivery
```
PATCH /deliveries/:id                                Admin Auth
```
**Request:** `{ "personnelId": "new_uuid", "priority": "high" }`

### 4.7 Cancel Delivery (via status update)
```
PATCH /deliveries/:id/status                         Admin Auth
```
**Request:** `{ "status": "cancelled", "notes": "Customer cancelled" }`

---

## 5. Deliveries - Personnel (7 APIs)
**Base path:** `/deliveries`

### 5.1 Get My Deliveries
```
GET /deliveries/my/assigned                          Delivery Auth
```
**Query:** `?personnelId=<myUserId>&page=1&limit=20`
Returns active deliveries (pending, picked_up, in_transit, arrived).

### 5.2 Get My Dashboard
```
GET /deliveries/my/dashboard                         Delivery Auth
```
**Response:**
```json
{
  "today": {
    "assigned": 8,
    "completed": 5,
    "inTransit": 1,
    "remaining": 2,
    "progress": 62
  },
  "nextDelivery": { ... } | null
}
```

### 5.3 Update Delivery Status
```
PATCH /deliveries/:id/status                         Delivery Auth
```
**Request:**
```json
{
  "status": "picked_up",
  "notes": "All items collected",
  "location": { "lat": 31.5204, "lng": 74.3587 }
}
```
**Valid Transitions:** `pending` → `picked_up` → `in_transit` → `arrived` → `delivered`/`failed`

### 5.4 Capture Signature
```
POST /deliveries/:id/signature                       Delivery Auth
```
**Request:**
```json
{
  "signatureImage": "data:image/png;base64,iVBORw0KGgo...",
  "signerName": "Muhammad Ahmed"
}
```

### 5.5 Confirm Customer Receipt
```
POST /deliveries/:id/confirm                         Delivery Auth
```
**Request:**
```json
{
  "customerVerified": true,
  "deliveredItems": [
    { "itemId": "uuid", "deliveredQty": "10", "returnedQty": "0" }
  ],
  "notes": "All items delivered"
}
```

### 5.6 Report Issue
```
POST /deliveries/:id/issues                          Delivery Auth
```
**Request:**
```json
{
  "issueType": "customer_refused",
  "notes": "Customer not available. Called 3 times.",
  "photoUrl": "https://..."
}
```
**Issue Types:** `damaged`, `wrong_item`, `customer_refused`, `access_denied`, `payment_issue`, `other`

### 5.7 Get My History
```
GET /deliveries/my/history                           Delivery Auth
```
**Query:** `?page=1&limit=20`
Returns completed/failed/returned/cancelled deliveries.

---

## 6. Inventory Approvals (4 APIs)
**Base path:** `/inventory-approvals`

### 6.1 Get Pending Approvals
```
GET /inventory-approvals                             Admin Auth
```
**Query:** `?status=pending&page=1&limit=20`

### 6.2 Get Request Detail
```
GET /inventory-approvals/:id                         Admin Auth
```

### 6.3 Create Inventory Update Request
```
POST /inventory-approvals                            Delivery Auth
```
(Usually auto-created after delivery confirm)

### 6.4 Approve / Reject Request
```
PATCH /inventory-approvals/:id/review                Admin Auth
```
**Request (Approve):**
```json
{
  "decision": "approved",
  "notes": "Verified against signature"
}
```
**Request (Reject):**
```json
{
  "decision": "rejected",
  "notes": "Signature mismatch"
}
```

---

## 7. Shadow Inventory (3 APIs)
**Base path:** `/shadow-inventory`

### 7.1 Get My Shadow Inventory
```
GET /shadow-inventory                                Delivery Auth
```
**Query:** `?personnelId=<myUserId>&page=1&limit=20`

### 7.2 Update Shadow Entry
```
PATCH /shadow-inventory/:id                          Delivery Auth
```

### 7.3 Sync / Submit Shadow Inventory
```
POST /shadow-inventory/sync/:personnelId             Delivery Auth
```

---

## 8. Banking & Reconciliation (8 APIs)
**Base path:** `/banking`

### 8.1 Get Bank Accounts
```
GET /banking/accounts                                User Auth
```

### 8.2 Create Bank Account
```
POST /banking/accounts                               Admin Auth
```
**Request:**
```json
{
  "name": "Business Savings",
  "bankName": "MCB",
  "accountNumber": "1234567890",
  "accountType": "savings",
  "openingBalance": 100000,
  "linkedAccountId": "acc_1020",
  "openingDate": "2024-01-01"
}
```

### 8.3 Get Bank Register
```
GET /banking/accounts/:id/transactions               User Auth
```
**Query:** `?page=1&limit=20`

### 8.4 Add Bank Transaction
```
POST /banking/transactions                           Admin Auth
```
**Request:**
```json
{
  "bankAccountId": "uuid",
  "type": "expense",
  "date": "2024-01-15",
  "payee": "Office Depot",
  "amount": 5000,
  "accountId": "acc_6300",
  "reference": "CHK-1002",
  "memo": "Office supplies"
}
```
**Types:** `deposit`, `check`, `expense`, `transfer`

### 8.5 Bank Transfer
```
POST /banking/transfers                              Admin Auth
```
**Request:**
```json
{
  "fromAccountId": "bank_001",
  "toAccountId": "bank_002",
  "amount": 100000,
  "date": "2024-01-15",
  "memo": "Transfer to savings"
}
```

### 8.6 Start Reconciliation
```
POST /banking/reconciliations                        Admin Auth
```
**Request:**
```json
{
  "bankAccountId": "uuid",
  "statementDate": "2024-01-31",
  "statementEndingBalance": 445000,
  "transactionIds": ["txn_001", "txn_002"]
}
```

### 8.7 Get Unreconciled Transactions
```
GET /banking/reconciliations/unreconciled            Admin Auth
```
**Query:** `?bankAccountId=uuid`

### 8.8 Get Reconciliation History
```
GET /banking/accounts/:id/reconciliations            Admin Auth
```

---

## 9. Payroll & Employees (6 APIs)
**Base path:** `/employees` and `/payroll`

### 9.1 Get All Employees
```
GET /employees                                       User Auth
```
**Query:** `?department=Operations&status=active&page=1&limit=20`

### 9.2 Create Employee
```
POST /employees                                      Admin Auth
```
**Request:**
```json
{
  "firstName": "Ahmad",
  "lastName": "Khan",
  "email": "ahmad@company.pk",
  "phone": "+92-300-1234567",
  "department": "Operations",
  "position": "Manager",
  "hireDate": "2024-01-15",
  "payType": "salary",
  "salary": 100000,
  "payFrequency": "monthly"
}
```

### 9.3 Get Payroll Worksheet
```
GET /payroll/worksheet                               Admin Auth
```

### 9.4 Run Payroll
```
POST /payroll/runs                                   Admin Auth
```
**Request:**
```json
{
  "payPeriod": "monthly",
  "periodStart": "2024-01-01",
  "periodEnd": "2024-01-31",
  "payDate": "2024-01-31",
  "employees": [
    { "employeeId": "uuid", "hoursWorked": 160, "grossPay": 100000 }
  ]
}
```

### 9.5 Get Payroll History
```
GET /payroll                                         Admin Auth
```

### 9.6 Get Pay Stubs
```
GET /payroll/pay-stubs/:payrollRunId                  Admin Auth
```

---

## 10. Reports (12 APIs)
**Base path:** `/reports`

All reports accept `?format=json` (default) or `?format=csv`.

### 10.1 Profit & Loss
```
GET /reports/profit-loss                             User Auth
```
**Query:** `?startDate=2024-01-01&endDate=2024-12-31`

### 10.2 Balance Sheet
```
GET /reports/balance-sheet                           User Auth
```
**Query:** `?asOfDate=2024-12-31`

### 10.3 Cash Flow Statement
```
GET /reports/cash-flow                               User Auth
```
**Query:** `?startDate=2024-01-01&endDate=2024-12-31`

### 10.4 Trial Balance
```
GET /reports/trial-balance                           User Auth
```
**Query:** `?asOfDate=2024-12-31`

### 10.5 AR Aging
```
GET /reports/ar-aging                                User Auth
```

### 10.6 AP Aging
```
GET /reports/ap-aging                                User Auth
```

### 10.7 Inventory Valuation
```
GET /reports/inventory-valuation                     User Auth
```

### 10.8 Sales by Customer
```
GET /reports/sales-by-customer                       User Auth
```

### 10.9 Sales by Item
```
GET /reports/sales-by-item                           User Auth
```

### 10.10 Sales Tax Report
```
GET /reports/tax-report                              User Auth
```
**Query:** `?startDate=2024-01-01&endDate=2024-12-31`

### 10.11 Delivery Daily Report
```
GET /reports/delivery-daily                          User Auth
```

### 10.12 Delivery Performance
```
GET /reports/delivery-performance                    User Auth
```

---

## 11. Budgets (3 APIs)
**Base path:** `/budgets`

### 11.1 Get All Budgets
```
GET /budgets                                         User Auth
```

### 11.2 Create Budget
```
POST /budgets                                        Admin Auth
```

### 11.3 Get Budget vs Actual
```
GET /reports/budget-comparison                       User Auth
```
**Query:** `?budgetId=uuid`

---

## 12. Tax Management (4 APIs)
**Base path:** `/taxes`

### 12.1 Get All Tax Rates
```
GET /taxes/rates                                     User Auth
```

### 12.2 Create Tax Rate
```
POST /taxes/rates                                    Admin Auth
```
**Request:**
```json
{
  "name": "GST",
  "rate": 17,
  "description": "General Sales Tax",
  "isActive": true
}
```

### 12.3 Get Tax Liability
```
GET /taxes/liability                                 User Auth
```
**Query:** `?asOfDate=2024-12-31`

### 12.4 Record Tax Payment
```
POST /taxes/payments                                 Admin Auth
```

---

## 13. Notifications (4 APIs)
**Base path:** `/notifications`

### 13.1 Get Notifications
```
GET /notifications                                   User Auth
```
**Query:** `?userId=<myUserId>&page=1&limit=20`

### 13.2 Mark as Read
```
PATCH /notifications/:id/read                        User Auth
```

### 13.3 Mark All as Read
```
POST /notifications/read-all                         User Auth
```

### 13.4 Get Unread Count
```
GET /notifications/unread-count                      User Auth
```
**Query:** `?userId=<myUserId>`

---

## 14. Audit Trail (2 APIs)
**Base path:** `/audit`

### 14.1 Get Audit Entries
```
GET /audit                                           Admin Auth
```
**Query:** `?module=invoices&resourceType=invoice&userId=uuid&page=1&limit=50`

### 14.2 Get Audit by Resource
```
GET /audit/resource/:type/:id                        Admin Auth
```

---

## 15. Settings (4 APIs)
**Base path:** `/settings`

### 15.1 Get Company Settings
```
GET /settings                                        Admin Auth
```

### 15.2 Update Settings
```
PATCH /settings                                      Admin Auth
```

### 15.3 Get All Users
```
GET /settings/users                                  Admin Auth
```

### 15.4 Invite User
```
POST /settings/users/invite                          Admin Auth
```
**Request:** `{ "email": "new@company.pk", "role": "staff", "displayName": "New User" }`

---

# Frontend Integration Checklist

- [ ] Set `API_BASE_URL=https://finmatrix-api-a824f23fbd72.herokuapp.com/api/v1`
- [ ] Add interceptor: inject `Authorization: Bearer <token>` + `x-company-id: <companyId>` on every request
- [ ] On `401`: call `/auth/refresh-token` once, retry. If still fails → redirect to login
- [ ] Store `refreshToken` securely (httpOnly cookie preferred)
- [ ] Handle `429 Too Many Requests` with exponential backoff
- [ ] Use `GET /auth/me` on app start to resolve user + companies
- [ ] For PDFs: use `responseType: 'blob'` then `URL.createObjectURL(blob)`
- [ ] Parse `companyId` from signin response for immediate navigation
- [ ] All list endpoints support `?page=N&limit=N` pagination

---

# Error Codes Reference

| HTTP Status | Code | Meaning |
|-------------|------|---------|
| 400 | `VALIDATION_ERROR` | Request body validation failed |
| 400 | `CANNOT_EDIT_POSTED` | Cannot edit posted journal entries |
| 400 | `UNBALANCED_ENTRY` | Debits != Credits |
| 401 | `INVALID_CREDENTIALS` | Wrong email/password |
| 401 | `TOKEN_EXPIRED` | JWT expired, use refresh |
| 403 | `FORBIDDEN` | Lacks required role |
| 404 | `NOT_FOUND` | Resource doesn't exist |
| 404 | `INVALID_CODE` | Invalid invite code |
| 409 | `CONFLICT` | Duplicate unique key |
| 429 | `TOO_MANY_REQUESTS` | Rate limited |
| 500 | `INTERNAL_ERROR` | Server error |

---

*Generated: May 2026 | FinMatrix Backend v0.0.1*
