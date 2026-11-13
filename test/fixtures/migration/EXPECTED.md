# Migration Center golden fixtures

Regenerate with `npm run fixtures:migration` (source: `workbook-builder.ts`).
Every file is "as at" the cutover date **2026-06-30**. Asserted by
`test/migration.acceptance.ts`; the numbers below are the ones it checks.

| File | Source | What it is | Expected result |
|---|---|---|---|
| `a-clean-starter.xlsx` | finmatrix_template | A furniture distributor. Instruction and example rows left in place. Lakh, international and `Rs` amounts; `dd/mm/yyyy` dates with a day over 12. An Urdu customer name. | No blocking issue. **Ready, readiness 100.** All nine checks pass at difference 0. TB debits = credits = **1,092,500.50**. AR 245,000 = 4 open invoices. AP 163,250 = 3 open bills. Inventory 182,000 = 3 stock lines. After commit, Migration Clearing (3950) = **0**, A = L + E, and the books are locked through 2026-06-29. Creates 2 accounts (1500, 2100), 4 customers, 2 vendors, 3 items, 4 invoices (INV-1002 part-paid 35,000) and 3 bills. |
| `b-unbalanced-tb.xlsx` | finmatrix_template | (a) with Retained Earnings 50 paisa short. | **SOURCE_TB_BALANCED fails** (difference −0.50). Checks 3–9 are reported as not run because nothing can be posted. Status `validated`, so sign-off and commit are refused. |
| `c-ar-mismatch.xlsx` | finmatrix_template | (a) with INV-1004 due 29,000, not 30,000. | **AR_MATCHES fails** (−1,000). **CLEARING_ZERO fails** (3950 = −1,000). ACCOUNT_BY_ACCOUNT fails on 1100. Cannot commit. |
| `d-stock-mismatch.xlsx` | finmatrix_template | (a) with 20 cushions on hand instead of 24. | **INVENTORY_MATCHES fails** (−5,000). **CLEARING_ZERO fails** (−5,000). ACCOUNT_BY_ACCOUNT fails on 1200. Cannot commit. |
| `e-duplicates-ambiguous-dates.xlsx` | finmatrix_template | (a) plus Al-Noor listed twice (same code), all invoice dates with day and month ≤ 12, and INV-1003 typed twice. | Two blocking **AMBIGUOUS_DATE_FORMAT** issues (invoice date and due date) and a blocking **DUPLICATE_RECORD** on the customer. Once dates are read as dd/mm, a second **DUPLICATE_RECORD** names the repeated INV-1003. After choosing dd/mm, merging the customer and skipping the repeat (with a reason), it is (a) again: **ready, 100%, all nine checks pass**. The skipped row appears on the certificate with its reason. |
| `f-messy-generic.xlsx` | generic_spreadsheet | The same books exported "as is": sheets named `TB June 2026`, `Gahak List`, `Suppliers`, `Party Balances`, `Creditors O-S`, `Maal`, `Closing Stock` and `Notes`. Roman Urdu headers (`Naam`, `Shehar`, `Udhaar Limit`), `A/c Code / Ledger / Dr / Cr` under a title row, a TOTAL line, and no Accounts sheet. | Every data sheet is recognised. Trial balance, customers, vendors, items and stock come in at confidence ≥ 0.9. `Notes` is ignored. `Party Balances` and `Creditors O-S` are proposed as Open Invoices / Open Bills at 0.6 and raise **MAPPING_UNCONFIRMED** for the owner. The TOTAL line is rejected with "A total line, not a record". 1500 and 2100 have no type anywhere, so they raise **UNKNOWN_ACCOUNT** (map them, or add an Accounts sheet). Not importable until the owner answers. Used for the B3 AI accuracy report. |

## TallyPrime fixtures (`tally/`)

Hand-written following TallyPrime's Data Interchange XML structure, with the same books as (a). No real customer data. Uploaded together (five files, or one ZIP of them) with source `tally`.

| File | Tally export | What it exercises |
|---|---|---|
| `tally-masters.xml` | All Masters | Predefined groups plus a user group (`Lahore Customers` under Sundry Debtors). The reserved `Cash` and `Profit & Loss A/c` ledgers. A bank, a fixed asset, an unsecured loan and capital. Six party ledgers, one with an Urdu name. Stock groups and items with part numbers, opening rates and price lists. |
| `tally-trial-balance.xml` | Trial Balance, ledger-wise, closing | Debits written negative as Tally does. A `Sundry Debtors` group subtotal line that must be ignored. `Closing Stock`. |
| `tally-bills-receivable.xml` / `tally-bills-payable.xml` | Bill-wise outstanding | Pending amounts with `dd-Mmm-yyyy` dates. Tally carries no original amount, so the original equals the pending amount. |
| `tally-stock-summary.xml` | Stock Summary, closing | `12 pcs` quantities and `8500.00/pcs` rates. Stock-group subtotal lines that must be ignored. |

**Expected:** the eight starter sheets are produced at confidence 1, with no issues. Cash maps to 1000, Profit & Loss A/c to 3100 and Closing Stock to 1200. Debtor ledgers go to 1100 and creditor ledgers to 2000. New accounts get numbers by type: 18001 Furniture & Fixtures (asset, Fixed Asset), 18002 Meezan Bank (asset, Bank), 28001 Short-term Loan (liability, Notes Payable) and 38001 Owner Capital (equity, Owner Equity). The result is **ready, 100%, and all nine checks pass at zero difference**. After commit, debits = credits = 1,092,500.50, AR 245,000, AP 163,250, inventory 182,000 and Migration Clearing 0.
