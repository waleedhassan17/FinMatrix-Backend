# FinMatrix: Master Frontend API Specification

> **Base URL:** `https://finmatrix-api-830293a85dd8.herokuapp.com`
> **Swagger API Docs:** `https://finmatrix-api-830293a85dd8.herokuapp.com/api/docs`

This document is the **single source of truth** for all REST API endpoints required by the FinMatrix React Native frontend.

---

## Global API Rules

### Headers
Every authenticated request **MUST** include:
```http
Authorization: Bearer <accessToken>
X-Company-Id: <companyId>
```

### Response Envelope
All endpoints must return HTTP 200/201 (or appropriate 4xx/5xx) and wrap the payload in this shape:
```json
{
  "success": true,
  "data": { ... } // Payload here
}
```
If returning a paginated list, the `data` object must include pagination metadata:
```json
{
  "success": true,
  "data": {
    "items": [ { ... } ],
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

---

## 1. Authentication (`/api/v1/auth`)

### 1.1 User Sign In
- **Endpoint:** `POST /api/v1/auth/signin`
- **Request Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "SecurePassword123"
  }
  ```
- **Response Data:** Returns `{ "user": UserProfile, "tokens": { "accessToken": "...", "refreshToken": "..." } }`

### 1.2 User Sign Up
- **Endpoint:** `POST /api/v1/auth/signup`
- **Request Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "SecurePassword123",
    "displayName": "John Doe",
    "role": "admin",
    "phone": "+92-300-1234567"
  }
  ```
- **Response Data:** Returns `{ "user": UserProfile }`

### 1.3 Refresh Token
- **Endpoint:** `POST /api/v1/auth/refresh-token`
- **Request Body:**
  ```json
  {
    "refreshToken": "eyJhbG..."
  }
  ```
- **Response Data:** Returns `{ "tokens": { "accessToken": "...", "refreshToken": "..." } }`

### 1.4 Get Current User Profile
- **Endpoint:** `GET /api/v1/auth/me`
- **Request Body:** None
- **Response Data:** Returns `{ "user": UserProfile, "companies": [...] }`

### 1.5 Sign Out
- **Endpoint:** `POST /api/v1/auth/signout`
- **Request Body:** None
- **Response Data:** Returns `{ "success": true }`

### 1.6 Verify Email
- **Endpoint:** `POST /api/v1/auth/verify-email`
- **Request Body:**
  ```json
  {
    "token": "hex-verification-token"
  }
  ```
- **Response Data:** Returns `{ "verified": true }`

---

## 2. Core Entities

### 2.1 List Customers
- **Endpoint:** `GET /api/v1/customers?page=1&limit=20&search=term&isActive=true`
- **Request Body:** None
- **Response Data:** Paginated list of Customers.

### 2.2 Create Customer
- **Endpoint:** `POST /api/v1/customers`
- **Request Body:**
  ```json
  {
    "name": "Acme Corp",
    "email": "contact@acme.com",
    "phone": "+92-300-1234567",
    "billingAddress": { "city": "Lahore", "country": "Pakistan" },
    "creditLimit": 50000,
    "paymentTerms": "net30"
  }
  ```
- **Response Data:** Returns created Customer.

### 2.3 List Vendors
- **Endpoint:** `GET /api/v1/vendors?page=1&limit=20`
- **Request Body:** None
- **Response Data:** Paginated list of Vendors.

### 2.4 Create Vendor
- **Endpoint:** `POST /api/v1/vendors`
- **Request Body:**
  ```json
  {
    "companyName": "Supplier Inc",
    "contactPerson": "Jane Doe",
    "email": "supplier@vendor.com",
    "phone": "+92-42-1234567",
    "paymentTerms": "net30"
  }
  ```
- **Response Data:** Returns created Vendor.

### 2.5 List Agencies
- **Endpoint:** `GET /api/v1/agencies`
- **Request Body:** None
- **Response Data:** Paginated list of Agencies.

### 2.6 Create Agency
- **Endpoint:** `POST /api/v1/agencies`
- **Request Body:**
  ```json
  {
    "name": "North Branch",
    "code": "NB-01",
    "address": "123 North Street",
    "phone": "+1234567890"
  }
  ```
- **Response Data:** Returns created Agency.

---

## 3. Inventory

### 3.1 List Inventory Items
- **Endpoint:** `GET /api/v1/inventory/items?page=1&limit=20&category=Oil`
- **Request Body:** None
- **Response Data:** Paginated list of InventoryItems.

### 3.2 Create Inventory Item
- **Endpoint:** `POST /api/v1/inventory/items`
- **Request Body:**
  ```json
  {
    "sku": "SKU-001",
    "name": "Premium Oil",
    "category": "Cooking Oil",
    "unitOfMeasure": "bottle",
    "unitCost": 1500.00,
    "sellingPrice": 1800.00,
    "quantityOnHand": 200,
    "reorderPoint": 50
  }
  ```
- **Response Data:** Returns created InventoryItem.

### 3.3 Adjust Stock Levels
- **Endpoint:** `POST /api/v1/inventory/items/:id/adjust`
- **Request Body:**
  ```json
  {
    "adjustmentQty": -10,
    "reason": "Damaged goods removed"
  }
  ```
- **Response Data:** Returns updated InventoryItem.

---

## 4. Deliveries

### 4.1 List Deliveries
- **Endpoint:** `GET /api/v1/deliveries?status=pending&page=1`
- **Request Body:** None
- **Response Data:** Paginated list of Deliveries.

### 4.2 Create Delivery
- **Endpoint:** `POST /api/v1/deliveries`
- **Request Body:**
  ```json
  {
    "customerId": "uuid",
    "personnelId": "uuid-or-null",
    "priority": "high",
    "expectedDate": "2026-04-30",
    "notes": "Fragile",
    "items": [
      { "itemId": "uuid", "orderedQty": 50 }
    ]
  }
  ```
- **Response Data:** Returns created Delivery.

### 4.3 Update Delivery Status
- **Endpoint:** `PATCH /api/v1/deliveries/:id/status`
- **Request Body:**
  ```json
  {
    "status": "in_transit"
  }
  ```
- **Response Data:** Returns updated Delivery.

### 4.4 Submit Bill Photo (Multipart Form Data)
- **Endpoint:** `POST /api/v1/deliveries/:id/bill-photo`
- **Request Format:** `multipart/form-data`
  - `photo`: (File)
  - `signedBy`: "John Customer"
  - `source`: "camera"
  - `changes`: `[{"itemId": "uuid", "itemName": "Oil", "beforeQty": 100, "deliveredQty": 50, "returnedQty": 0}]`
- **Response Data:** Returns `{ "requestId": "uuid", "deliveryId": "uuid", "photoUrl": "https://...", "uploadedAt": "..." }`

### 4.5 Approve Inventory Request
- **Endpoint:** `POST /api/v1/inventory-update-requests/:id/approve`
- **Request Body:**
  ```json
  {
    "reviewerComment": "Approved and verified."
  }
  ```
- **Response Data:** Returns updated request with status `approved`.

---

## 5. Sales & Purchasing

### 5.1 Create Sales Order / Estimate
- **Endpoint:** `POST /api/v1/sales-orders` (or `/api/v1/estimates`)
- **Request Body:**
  ```json
  {
    "customerId": "uuid",
    "orderDate": "2026-04-29",
    "expectedDate": "2026-05-10",
    "notes": "Rush delivery",
    "lines": [
      {
        "itemId": "uuid",
        "description": "Premium item",
        "quantity": 10,
        "unitPrice": 100.00,
        "amount": 1000.00
      }
    ]
  }
  ```
- **Response Data:** Returns created order.

### 5.2 Create Purchase Order
- **Endpoint:** `POST /api/v1/purchase-orders`
- **Request Body:** Same as Sales Order but uses `"vendorId": "uuid"`.
- **Response Data:** Returns created PO.

### 5.3 Receive Purchase Order Items
- **Endpoint:** `POST /api/v1/purchase-orders/:id/receive`
- **Request Body:**
  ```json
  {
    "receivedLines": [
      { "lineId": "uuid", "receivedQuantity": 10 }
    ]
  }
  ```
- **Response Data:** Returns updated PO.

---

## 6. Accounting & General Ledger

### 6.1 Create Invoice
- **Endpoint:** `POST /api/v1/invoices`
- **Request Body:** Similar to Sales Order payload but for Invoices.

### 6.2 Receive Payment
- **Endpoint:** `POST /api/v1/payments`
- **Request Body:**
  ```json
  {
    "customerId": "uuid",
    "amount": 1000.00,
    "appliedInvoices": [
      { "invoiceId": "uuid", "amount": 1000.00 }
    ]
  }
  ```
- **Response Data:** Returns Payment record.

### 6.3 Create Journal Entry
- **Endpoint:** `POST /api/v1/journal-entries`
- **Request Body:**
  ```json
  {
    "date": "2026-04-29",
    "memo": "Depreciation adjustment",
    "lines": [
      { "accountId": "uuid-1", "debit": 500, "credit": 0 },
      { "accountId": "uuid-2", "debit": 0, "credit": 500 }
    ]
  }
  ```
- **Response Data:** Returns created JE.

---

## 7. Banking & Reconciliations

### 7.1 List Bank Accounts
- **Endpoint:** `GET /api/v1/banking/accounts`
- **Request Body:** None
- **Response Data:** Returns list of Bank Accounts.

### 7.2 Create Bank Transaction
- **Endpoint:** `POST /api/v1/banking/transactions`
- **Request Body:**
  ```json
  {
    "bankAccountId": "uuid",
    "date": "2026-04-29",
    "payee": "Office Depot",
    "type": "withdrawal",
    "amount": 150.00,
    "description": "Stationery"
  }
  ```
- **Response Data:** Returns created Transaction.

### 7.3 Transfer Funds
- **Endpoint:** `POST /api/v1/banking/transfers`
- **Request Body:**
  ```json
  {
    "fromAccountId": "uuid",
    "toAccountId": "uuid",
    "amount": 5000.00,
    "date": "2026-04-29"
  }
  ```
- **Response Data:** Returns Transfer Details.

### 7.4 Submit Bank Reconciliation
- **Endpoint:** `POST /api/v1/banking/reconciliations`
- **Request Body:**
  ```json
  {
    "bankAccountId": "uuid",
    "statementDate": "2026-04-30",
    "beginningBalance": 10000.00,
    "endingBalance": 12500.00,
    "clearedTransactionIds": ["uuid-1", "uuid-2"]
  }
  ```
- **Response Data:** Returns Reconciliation record.

---

## 8. Employees & Payroll

### 8.1 Create Employee
- **Endpoint:** `POST /api/v1/employees`
- **Request Body:**
  ```json
  {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "salary": 50000,
    "department": "Sales"
  }
  ```
- **Response Data:** Returns created Employee.

### 8.2 Process Payroll Run
- **Endpoint:** `POST /api/v1/payroll/runs`
- **Request Body:**
  ```json
  {
    "payPeriodStart": "2026-04-01",
    "payPeriodEnd": "2026-04-30",
    "paymentDate": "2026-05-01",
    "employeePayments": [
      { "employeeId": "uuid", "grossPay": 5000, "netPay": 4000, "taxes": 1000 }
    ]
  }
  ```
- **Response Data:** Returns Payroll Run record.

---

## 9. Tax Management

### 9.1 Create Tax Rate
- **Endpoint:** `POST /api/v1/taxes/rates`
- **Request Body:**
  ```json
  {
    "name": "Standard VAT",
    "rate": 17.5,
    "description": "National VAT",
    "isActive": true
  }
  ```
- **Response Data:** Returns Tax Rate.

### 9.2 Record Tax Payment
- **Endpoint:** `POST /api/v1/taxes/payments`
- **Request Body:**
  ```json
  {
    "taxAuthorityId": "uuid",
    "amount": 15000.00,
    "paymentDate": "2026-04-30",
    "bankAccountId": "uuid"
  }
  ```
- **Response Data:** Returns Tax Payment record.

---

## 10. Budgets

### 10.1 Create/Update Budget
- **Endpoint:** `POST /api/v1/budgets`
- **Request Body:**
  ```json
  {
    "fiscalYear": 2026,
    "name": "2026 Operating Budget",
    "lines": [
      {
        "accountId": "uuid",
        "monthly": { "jan": 100, "feb": 100, "mar": 100, "apr": 100, "may": 100, "jun": 100, "jul": 100, "aug": 100, "sep": 100, "oct": 100, "nov": 100, "dec": 100 },
        "total": 1200
      }
    ]
  }
  ```
- **Response Data:** Returns Budget record.

---

## 11. Reports & Analytics (`/api/v1/reports`)

All reports accept basic `GET` requests (with date filters) and return computed aggregates.

### 11.1 Analytics Dashboard
- **Endpoint:** `GET /api/v1/reports/dashboard`
- **Request Body:** None
- **Response Data:** `{ kpis, charts, recentActivity }`

### 11.2 Profit & Loss
- **Endpoint:** `GET /api/v1/reports/profit-loss`
- **Request Body:** None
- **Response Data:** Profit & Loss tree data.

### 11.3 Delivery Performance
- **Endpoint:** `GET /api/v1/reports/delivery-performance`
- **Request Body:** None
- **Response Data:** Array of Delivery Personnel efficiency metrics.

### 11.4 Inventory Valuation
- **Endpoint:** `GET /api/v1/reports/inventory-valuation`
- **Request Body:** None
- **Response Data:** `[{ itemId, itemName, quantityOnHand, unitCost, totalValue }]`
