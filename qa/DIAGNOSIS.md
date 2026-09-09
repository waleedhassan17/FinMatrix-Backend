# Diagnosis — "nothing shows up in the General Ledger / Reports"

Run `qa/diagnose-company.sql` first. It answers, for one company, which of three
things you are looking at:

| What you see | What it means |
|---|---|
| Section 1 shows **0 posted entries** | Nothing was ever posted. Go to sections 3–8. |
| Section 1 shows posted entries whose **date range misses the report's range** | The books are fine. The screen is asking for a window the entries do not fall in. |
| Sections 4–7 return **rows** | A flow is silently failing. Each section says what the row means. |

Run it like this — note the double quoting, because psql substitutes `:companyId`
literally and the value has to arrive carrying its own SQL quotes:

```bash
docker exec -i finmatrix-postgres psql -U finmatrix_user -d finmatrix \
  -v companyId="'<uuid>'" -f - < qa/diagnose-company.sql

psql "$DATABASE_URL" -v companyId="'<uuid>'" -f qa/diagnose-company.sql
```

Every statement is a `SELECT`; the file never writes.

Pair it with the gate that runs across *all* companies and fails the build:

```bash
npm run test:qa      # qa/invariants.sql — I7 catches posted documents with no journal entry
```

---

## The single most common answer

**Delivery revenue posts at admin approval, never at dispatch.**

Dispatching a delivery posts `Dr Goods in Transit / Cr Inventory` and nothing else —
no revenue, no COGS, balance sheet only. That is correct: control has not transferred,
so under IFRS 15 / ASC 606 there is no sale yet. Revenue and COGS post together when
the owner approves the delivery.

So a delivery sitting at `ledger_status = 'in_transit'` **correctly** contributes
nothing to the P&L. Section 3 counts these. If that count is high, deliveries are
piling up waiting for sign-off — the ledger is not broken.

---

## Findings on the local dev database (2026-09-09)

Read-only. Nothing was run against production.

### `Warehouse Co` — `a6975a1e-445c-420a-ad9a-b169c4a1fd4d`

| Section | Result |
|---|---|
| 1. Books | 993 posted entries, 2025-11-30 → 2026-09-07. Also 15 draft, 26 void. |
| 2. Ledger integrity | 2540 ledger-bound lines = 2540 GL rows ✓ |
| 3. Deliveries | 40 committed, 28 returned, **1 `in_transit`** (`DEL-MRZHU4C0-BZHA`, priced 540 — dispatched, awaiting approval) |
| 4. Approved with no sale | none ✓ |
| 5. Unpriced lines awaiting approval | none ✓ |
| 6. Items with no selling price | 0 of 59 ✓ |
| 7. Legacy approval path | none ✓ |
| 8. Drafts | 1 invoice (correctly unposted) |

**These books are healthy.** Every non-draft invoice carries a journal entry, the
ledger foots, and the one delivery showing no revenue is simply awaiting approval.

Widening section 5 and 6 across **every** company in the dev database also returned
nothing: no delivery anywhere had all its lines unpriced, and no inventory item
anywhere was priced at zero.

> **Test fixtures.** `test/reports-reflect.acceptance.ts` deliberately keeps one
> zero-priced item (`RPT-U-…`) in the company it runs against, because it has to
> prove that approving an all-unpriced delivery is refused. Expect exactly one
> such row in section 6 on any database the suite has run against, and none in
> section 5 — the suite rejects its own delivery afterwards so the stock goes
> back and nothing is left stranded. More than one means an older build left
> fixtures behind; give them a selling price and they drop out.

### One thing worth knowing about section 2

Voided entries keep their ledger rows. Voiding does not delete anything — the original
lines and their GL rows stay on file and are cancelled by a separate reversing entry,
which is what keeps the trail auditable. Counting only `status = 'posted'` on the
left-hand side therefore reports a gap that is not there; on Warehouse Co that was 26
voided entries showing up as a phantom 52-row shortfall. Section 2 counts
`posted` **and** `void` on both sides, and excludes `draft` from both.

---

## Which root causes actually apply

The external audit named four. Verified against current `main`:

| Cause | Verdict |
|---|---|
| **RC‑1** — delivery approval fails on an all-unpriced delivery, with a cryptic engine error | **Real, latent.** The code path is confirmed: `delivery-ledger.service.ts commitApproval` builds invoice lines straight from `delivery_items.unit_price` and nothing checks the total, so a zero-total invoice reaches the posting engine and is rejected with `VALIDATION_FAILED` — a message the user cannot act on. No company in the dev database has hit it yet. Fixed by the `DELIVERY_ITEM_NO_PRICE` / `INVOICE_ZERO_TOTAL` guards. |
| **RC‑2** — dateless reports return all-zeros | **Does not apply.** `reports.service.ts` already defaults every date, and every frontend slice already sends dates. |
| **RC‑3** — draft invoices are invisible | **Does not apply.** Draft badges already render on every list and detail screen. The real gap was that a draft had no explicit *post* action, only a share-sheet side effect. |
| **RC‑5** — bill payment requires a proof | Works as designed. Note bill payment is `Dr A/P / Cr Bank`, balance sheet only — it will **never** appear in the P&L, which is correct, not a missing posting. |

### A zero-price line is not automatically a defect

`DEL-MSTFZEM3-LNLI` shipped a zero-price "Free Sample" alongside a paid line and posted
correctly (invoice 300, journal entry present). That is a supported case. Only a delivery
whose lines are **all** unpriced is a blocker, which is why section 5 reports
`all_lines_unpriced` separately from `unpriced_lines`, and why the backend guard rejects
only a whole invoice that totals zero while real cost is moving.
