# Reports API v2

For the Expo app and the web client. Every change is **additive**: no existing field has been renamed, removed or retyped, and no endpoint's default response has changed shape. A client built before v2 keeps working. The new data is in new fields and new routes. TypeScript interfaces for everything below live in `src/modules/reports/reports.types.ts`.

A few existing **values** change on purpose, all listed under [What moved](#what-moved). Read that section before shipping.

---

## Conventions

| Rule | Detail |
|---|---|
| Two response styles | The statements (`profit-loss`, `balance-sheet`, `trial-balance`, `cash-flow`, `ar-aging`, `ap-aging`, `inventory-valuation`) return the report object **directly**, with no envelope, as they always have. Every **new** route returns `{ success: true, data: … }` through the envelope. |
| No `data` or `success` keys | The envelope treats both specially, so no response object uses them. Rows are under `entries`, `rows` or `kpis`. |
| CSV is frozen | `format=csv` exports exactly the columns it did before v2. New fields are JSON-only. |
| Money | Rounded to 2 dp. Totals are summed from full-precision figures and rounded once, so a total can differ from the sum of its rounded lines by a paisa. Breakdowns that are shown beside a total (monthly series, schedules, counterparty splits) are apportioned so they foot to it exactly. |
| `change` | Always the difference of the two **displayed** figures (`current − prior` as printed). `changePct` is computed from full precision, and is null when the prior figure is 0 or missing. |
| Nulls | A ratio whose denominator is zero is `null`, never `Infinity`, `NaN` or `0`. KPIs also carry a `status` saying why. |
| Dates | `YYYY-MM-DD`. A malformed date → `400 INVALID_DATE`; start after end → `400 INVALID_RANGE`. |
| Pages | `page` from 1; `limit` capped at 200. Totals (`lineAmount`, `total`) always cover **all** pages. |
| Fiscal year | One source: `companies.fiscal_year_start_month` (NULL = January). `GET /settings` reports it as `fiscalYearStart: 'MM-01'`, and `PATCH /settings { fiscalYearStart }` writes through to it. `'MM'` or `'MM-01'` is accepted; anything else is `400 INVALID_FISCAL_YEAR_START`. |
| Grouping | Group statement lines by the server's `sections[].key` / `group`. Do **not** group by account-number range any more. |

---

## What moved

These figures change value. Every other existing figure is unchanged to the paisa; this was checked against a baseline of both demo companies.

| Where | Before | Now | Why |
|---|---|---|---|
| `balance-sheet` `equity[]` | One line `{ accountCode: '3100', accountName: 'Net Income (current period)' }` carrying net income **since inception**, and a second `3100` line when Retained Earnings had a posted balance. | The **Retained Earnings account line** = its posted balance + every earlier fiscal year's net income, with `composite: { postedBalance, priorYearsEarnings }`. When the chart has no such account, a synthetic `{ accountCode: '', accountName: 'Retained Earnings', synthetic: 'retainedEarnings' }` line instead. Plus `{ accountCode: '', accountName: 'Net Income (current fiscal year)', synthetic: 'currentYearEarnings' }`. | The current year was mixed with all prior years, under the code of a real account. **`totalEquity`, the totals and `isBalanced` are unchanged.** |
| `cash-flow` sections | Capex paid by bill was in "Cash paid to suppliers". Loans, owner capital and drawings posted as journals were in operating "Other cash movements". | Classified by what the cash was exchanged for: capex → **investing**; loans, owner contributions and drawings → **financing**. A cash ↔ bank transfer is in no section. | Operating cash was overstated or understated whenever the business invested or borrowed. **`netChange`, `beginningCash` and `endingCash` are unchanged.** |
| `cash-flow` `operatingIndirect` | Opening balances, opening stock and capex bought on credit left an "Other operating adjustments" residual (149,980 on Warehouse Co). | They are excluded as non-cash (IAS 7.43) and listed in `operatingIndirect.excludedNonCash`. The residual is 0 on every company tested. New lines: "Prepaid expenses" and "Other non-cash items". | The walk now explains the whole operating figure. |
| `cash-flow` `monthlyTrend` | The last 12 months that **had** cash movement. | Every calendar month of the range (zero-filled), the last 12 of them. | A quiet month is a zero bar, not a missing one. |
| `profit-loss` `otherIncome` / `otherExpense` | Only 7xxx/8xxx accounts. | Also revenue subtypes **Interest** and **Other Revenue**, and expense subtype **Other Expense**. | The old check looked for a subtype ('Other Income') that does not exist. `revenue`, `expenses` and `netIncome` do not move. |
| `profit-loss` `netOperatingIncome` | `grossProfit − totalExpenses`, which included other income. | `totalIncome − cogs − totalExpenses`, so `netOperatingIncome + netOtherIncome = netIncome`. | Other income was counted twice. Identical for any company without non-operating revenue. |
| `item-performance` `customers[]` / `otherCustomers` | Summed over the whole requested range, while the monthly points and `totals` covered at most the last 60 months of it. | Summed over the same months as the points (the chart's window, at most 60 months), so customers and channels add up to `totals`. | They described a different period from the figures beside them. **Identical for any range of 60 months or less** — every range the app and web send. Only an undated call (all time) or a longer range sees the shorter window. |

---

## Existing endpoints: new fields

### `GET /reports/balance-sheet?asOfDate&compareTo&includeZero`
`compareTo` (optional) must be a real date **before** `asOfDate`, else `400 INVALID_COMPARE_DATE`. Without `compareTo` the endpoint is exactly as lenient as before.

`includeZero=true` (optional, the literal `true`) also lists every **active** account with no balance, at 0, in its section of `sections[]`. No total, subtotal or flat legacy array (`assets`, `liabilities`, `equity`) changes, and neither does the CSV.

Fields added (`BalanceSheetReport`):
- **`fiscalYearStart`**.
- **`gap`**: A − (L + E), computed raw then rounded; 0 when balanced.
- **`totalLiabilitiesAndEquity`**.
- **`sections[]`**:
  - in order: `cashAndBank`, `receivables`, `inventory`, `otherCurrentAssets`, `fixedAssets`, `currentLiabilities`, `longTermLiabilities`, `equity`;
  - each section has `subtotal`, `priorSubtotal`, `change`, `changePct` and `subtotalPctOfTotalAssets`;
  - each line has `accountCode`, `accountName`, `subType`, `amount`, `priorAmount`, `change`, `changePct`, `pctOfTotalAssets`, and `synthetic?` / `composite?`;
  - with `compareTo`, an account that is zero now but was not then still appears.
- **`subtotals[]`**: keys `totalCurrentAssets`, `totalAssets`, `totalCurrentLiabilities`, `totalLiabilities`, `totalEquity` and `totalLiabilitiesAndEquity`, each with `amount`, `priorAmount`, `change`, `changePct` and `pctOfTotalAssets`.
- **`comparison`**: `{ asOfDate, totalAssets, totalLiabilities, totalEquity }`, or null.

Grouping rule:
- The account's **subtype** decides its section.
- `Other Asset` numbered **≥ 1500** is a fixed asset; below 1500 it is current (so 1300 Input Tax stays current).
- `Notes Payable` is the only long-term liability subtype.
- The account-number range is used only for an unknown or empty subtype.

### `GET /reports/trial-balance?startDate&endDate&mode&includeZero`
- **No `mode`**: byte-identical to before (period movement).
- **`mode=movement`**: the same figures. Rows gain `accountType`, `subType`, `group` and `flags[]`, and the response gains `groups[]`.
- **`mode=closing`**: balances as of `endDate` (default today):
  - balance-sheet accounts are cumulative;
  - revenue and expense are **fiscal year to date**;
  - one synthetic row `{ accountCode: '', accountName: "Retained earnings — prior years' net income", synthetic: true }` makes it balance (the same split as the balance sheet).
- **`mode=working`**:
  - each row has `openingDebit/Credit` (as of the day before `startDate`, with the fiscal year of `startDate`), `periodDebit/Credit` and `closingDebit/Credit`;
  - `debit`/`credit` mirror closing;
  - the response adds `balanced: { opening, period, closing }` and `totals`;
  - `warnings: [{ code: 'CROSSES_FISCAL_YEAR', message }]` when the range spans a fiscal year.
- **`flags`** are read off the closing balance:
  - `abnormal_balance`: a debit-normal account (assets, expenses, Owner Draws) with a credit balance, or the reverse;
  - `contra_assumed`: an asset named like "Accumulated …", treated as a contra account and exempt from `abnormal_balance`;
  - `obe_nonzero`: Opening Balance Equity not cleared.
- **`groups[]`**: `{ key, label, debit, credit, … }` per group, with every column pair the mode returns. Keys are the balance-sheet sections above plus `income`, `costOfGoods`, `expenses`, `otherIncome` and `otherExpense`.
- **`includeZero=true`** (with a `mode`): every active account of the chart gets a row, even one with nothing in any column. Totals are unchanged; a group can appear at 0 for the zero rows it heads. The synthetic prior-years row still appears only when it is not zero.
- An unknown mode → `400 INVALID_MODE`.

### `GET /reports/cash-flow?startDate&endDate`
- **Lines** gain `lineKey` and `section` (see [line keys](#cash-flow-line-keys)).
- **`monthlyTrend[]`** points gain `endingCash` (Cash + Bank at month end).
- **`accounts[]`**: `{ accountCode, accountName, beginning, ending }` for each cash or bank account; Σ `ending` = `endingCash`.
- **`cashTie`**: `{ endingCash, balanceSheetCash, ties }`.
- **`operatingIndirect.excludedNonCash[]`**: what was kept out of working capital, and its effect.
- **`monthly[]`** (`CashFlowMonth`): the same months as `monthlyTrend`, zero-filled, each `{ period: 'YYYY-MM', label, inflow, outflow, net, endingCash }`.
  - `inflow` and `outflow` are both positive: cash received and cash paid out in the month, from the same classified postings as the sections.
  - A transfer between the company's own cash and bank accounts is in **neither** column.
  - `net` = `inflow − outflow` = that month's `monthlyTrend.value`; Σ `net` = `netChange`; `endingCash` = `monthlyTrend.endingCash`.

### `GET /reports/ar-aging` and `/reports/ap-aging` (JSON only)
- **`insights`** (`AgingInsights`):
  - `dso` (AR) or `dpo` (AP) as a KPI object;
  - `totalOpen` (= `totals.total`), `overdue`, `overduePct`;
  - `weightedAvgDaysOverdue` (balance-weighted over overdue documents; null when nothing is overdue);
  - `top5SharePct`;
  - `schedule[]` by due date from today: `overdue`, `d0_7`, `d8_14`, `d15_30`, `d31_60`, `d60_plus`, each `{ key, label, amount, count }`. Σ `amount` = `totalOpen`;
  - `assessments: { overduePct, weightedAvgDaysOverdue, top5SharePct }`, each a `KpiAssessment` (see [Assessments](#assessments)). On A/P, concentration is stated, never judged (`neutral`).
- **Each row** gains `paymentTerms`, `lastPaymentDate`, `lastPaymentAmount` and `oldestDueDate`. AR rows also gain `creditLimit` (0 = no limit), `overLimit` and `creditUsedPct` (null when there is no limit).
- **Best effort.** `insights` and the row fields are extras on a long-standing report: if computing them fails, the response is the pre-v2 aging report exactly (no `insights`, no row fields) and the failure is logged. If only the KPI fails, `insights.dso` / `insights.dpo` is `null`. Read both as optional.

### `GET /reports/inventory-valuation?asOfDate`
- **Without `asOfDate`**: unchanged.
- **With `asOfDate`** (`InventoryValuationAsOf`):
  - each item's quantity and value come from the dated movement record;
  - an item with an unvalued movement has `value: null` (nothing is estimated);
  - `coverage` says how much of the record carries cost;
  - `ledgerTie: { gl1200, valuation, gap }` compares the total with **GL 1200 only**. 1250 Goods in Transit is excluded.

### `GET /reports/item-performance/:itemId?startDate&endDate`
The item explorer. Every field below is additive; a client that predates them reads the rest unchanged.
- **`item`** gains:
  - `imageUrl`, `thumbnailUrl`: the item's photo, as signed links like the inventory list's. Both null without a photo.
  - `location`: the name of the location the item is kept at, or null.
  - `stockStatus`: `'ok' | 'low' | 'out'`. Out at zero or below; low at or below a reorder point that is set. This is the Health tab's reorder rule.
  - `suggestedOrderQty`: `max(reorderQuantity, reorderPoint − qtyOnHand)` when low or out against a reorder point; otherwise null. This is the reorder list's figure.
  - `daysOfCover`: on hand ÷ (units sold ÷ days of the window that have passed), rounded. Null when nothing sold; 0 with nothing on hand.
  - `cover`: the verdict on `daysOfCover` (see [Assessments](#assessments)).
  - `deadStock`, `lastOutboundDate`: on hand with no sale or delivery out in more than 180 days, or ever. This is the Health tab's dead-stock rule, from the same `inventory-movement-rules.ts`.
- **`customers[]`** gain `sharePct`, a share of the window's revenue. **`otherCustomers`** gains `sharePct` too. Each is null for a negative part, or when revenue is zero or below.
- **`channels[]`**: `{ key: 'invoice' | 'delivery', unitsSold, revenue, grossProfit, documents, sharePct }`, listing only the channels that sold.
  - `sharePct` is a share of what went out before returns.
  - `delivery` is stock sold on a delivery's invoice, with returns at the door already netted out.
- **`returns`**: `{ unitsSold, revenue, grossProfit, documents }` from credit notes (all negative), or null.
- Σ channels + returns = `totals`, for revenue and units alike: they group the same lines as the months.

---

## New endpoints (all `{ success, data }`, `admin` and `staff`)

### `GET /reports/accounts/:accountCode/register`
Query: `startDate`, `endDate`, `page`, `limit` (≤ 200), `order=asc|desc` (default **asc**, oldest first).

Returns `AccountRegister`:
- `openingBalance`, `periodDebit`, `periodCredit`, `periodNet`, `closingBalance`;
- `entries[]` each with `runningBalance`. It is exact on every page and in either order, because it is computed over the whole range before paging.

Opening basis:
- balance-sheet accounts carry everything before `startDate` (`openingBasis: 'cumulative'`);
- revenue and expense accounts restart at the fiscal year containing `startDate` (`'fiscalYearToDate'`).

Invariant: opening + Σ `amount` = closing.

Errors: `404 ACCOUNT_NOT_FOUND`, `400 INVALID_ORDER`, `400 INVALID_ACCOUNT_CODE`.

### `GET /reports/accounts/:accountCode/movement`
Query: `startDate`, `endDate` (both required); `compareStartDate` and `compareEndDate` (optional, both or neither); `limit` (counterparties before "Other", default 10).

Default comparison period:
- a whole-month range compares with the same number of **whole months** before it (Jul–Dec against Jan–Jun);
- any other range compares with the same number of days before it.

Returns `AccountMovement`: `byCounterparty[]` (`Unattributed` = no customer or vendor behind the row) and `bySourceType[]`, each sorted by |change|. Σ `change` = `change` in both.

### `GET /reports/balance-sheet/retained-earnings?asOfDate`
Returns `RetainedEarningsBreakdown`: each prior fiscal year's net income, plus what was posted to the Retained Earnings account. `total` equals the balance sheet's Retained Earnings line exactly.

### `GET /reports/cash-flow/lines/:lineKey/entries`
Query: `startDate`, `endDate` (default today), `page`, `limit` (≤ 200).

Returns `CashFlowLineEntries`: the cash rows behind one line, newest first.

When a posting's cash was split across lines (a loan repayment with interest, a bill payment for a machine and some supplies), the row appears under each line with `allocatedAmount` and `allocationPct`.

Invariant: Σ `allocatedAmount` = `lineAmount`.

Errors: `400 UNKNOWN_LINE_KEY`.

### `GET /reports/financial-health?asOfDate`
`{ asOfDate, kpis: Kpi[] }`. See [KPIs](#kpis).

### `GET /reports/analytics?startDate&endDate&expenseTop&customerTop` — Owner Cockpit
Default range: the fiscal year to date. More than 60 months → `400 RANGE_TOO_LONG`.

`expenseTop` and `customerTop` (optional integers) say how many expense accounts and customers to name before "Other". They are clamped to 3–10, and the defaults stay 8 and 10. A donut asks for 5, so the client never adds the tail up itself. A value that is not a whole number → `400 INVALID_TOP`.

Returns `OwnerAnalytics`:
- **`series[]`**: every month of the range, zero-filled, with `revenue`, `cogs`, `grossProfit`, `operatingExpenses`, `netIncome`, `operatingCashFlow` and `endingCash`. Each P&L series adds up to the P&L for the same range to the paisa; `operatingCashFlow` adds up to the cash-flow statement's operating total.
- **`kpis[]`** (`ComparedKpi`): `revenue`, `grossProfit`, `grossMarginPct`, `netIncome` (labelled "Net profit"), `netMarginPct`, `operatingExpenses`, `operatingCashFlow`, `endingCash`, `runwayMonths`, `dso`, `dpo`, `dio` and `ccc`, each with `current`, `prior`, `change`, `changePct` against `comparisonRange`, and its `assessment`. `grossProfit` and `netIncome` are the P&L's own figures, so the headline cards never add up a series.
- **`expenseByAccount[]`**: the top `expenseTop` (default 8) operating expense accounts plus "Other". Σ = operating expenses. Each line's `sharePct` is its share of operating expenses; null when the total is not positive or the line is a credit (a credit is no slice of what was spent, so a client draws bars instead of a ring).
- **`salesByCustomer`**:
  - the top `customerTop` (default 10) customers, each with `invoices` and `sharePct` (of `total`), plus `other` (`count`, `amount`, `sharePct`), `top5SharePct` (over all customers, null when there are no sales) and its `assessment`;
  - it is on the **invoice basis** (invoice subtotal less discount, tax excluded, drafts and voids excluded, credit memos not netted). The response says so in `basis` and `label`.
- **`budgetVsActual`**:
  - the latest *active* budget whose year the range touches, via the existing budget vs-actual, or null;
  - budgets are calendar-year (`basis: 'calendarYear'`).
- **`health`**: `financial-health` at `endDate`.
- **`insights[]`** (`BusinessInsight`): what stands out in the period, most pressing first (`negative`, `warning`, `positive`, `neutral`), at most six. Each is `{ key, tone, title, detail, report: { key, params } }`.
  - Built only from figures already in this response, so a sentence never disagrees with the card beside it. Web and app render the text as sent.
  - `key`: `revenue`, `netLoss`, `grossMargin`, `margins`, `overdrawn`, `runway`, `cash`, `collections`, `concentration`, `opex`, `budget` or `revenueBudget`.
  - `report.key` names the report that explains it: `profitLoss`, `balanceSheet`, `cashFlow`, `arAging`, `apAging`, `inventoryValuation` or `budgets`. `report.params` are its query parameters (the range, or `{ budgetId }`).
  - The budget lines compare the range's months with the budget for the **same months**, never with the whole year.

`/reports/analytics-dashboard` is untouched.

### `GET /reports/inventory-health?asOfDate`
Returns `InventoryHealth`:
- **`belowReorder[]`**: **active** items with `reorderPoint > 0` and `qtyOnHand ≤ reorderPoint`; `suggestedOrderQty = max(reorderQuantity, reorderPoint − qtyOnHand)`. A discontinued (inactive) item is never suggested for reordering; its stock still counts in aging, dead stock and the totals.
- **`aging.byLastInbound[]` / `aging.byLastOutbound[]`**: buckets `d0_30`, `d31_90`, `d91_180`, `d180_plus` and `noMovement`, each with `count` and `value`.
  - Inbound = a receipt, a return, or opening stock.
  - Outbound = a sale or a delivery.
  - A reversal does not count.
- **`deadStock`**: on hand with no outbound movement in 180 days.
- **`turnover`** (KPI `inventoryTurnover`) and **`dio`** (KPI `dio12`), both over the trailing 12 months.
- **`byLocation[]`**: `{ location, value, count }`: the value and the number of items on hand at each location; `Unassigned` when an item has no location.
- **`totals`**: `{ itemCount, itemsOnHand, stockValue, valuationTotal }`.

For today, values are qty × average cost exactly as `inventory-valuation` computes them. For a past date they come from the movement record.

---

## KPIs

Every KPI is `{ key, label, value, unit, formula, inputs, asOfDate, status, assessment }`.
- `unit`: `'money' | 'ratio' | 'days' | 'months' | 'percent'`.
- `status`: `'ok' | 'no_denominator' | 'negative_equity' | 'cash_positive'`.
- `value` is null whenever `status ≠ 'ok'`.
- `inputs` are the figures used, so a screen can show the working.
- Groups (current assets and so on) are the balance sheet's `sections`.

| key | unit | formula |
|---|---|---|
| `cashAndBank` | money | Cash + Bank balances |
| `workingCapital` | money | Current assets − Current liabilities |
| `currentRatio` | ratio | Current assets ÷ Current liabilities |
| `quickRatio` | ratio | (Cash and bank + Receivables) ÷ Current liabilities |
| `debtToEquity` | ratio | Total liabilities ÷ Total equity; null + `negative_equity` when equity ≤ 0 |
| `dso` | days | Receivables ÷ **operating** revenue (trailing 90 days) × 90 |
| `dpo` | days | Accounts payable ÷ COGS (trailing 90 days) × 90 |
| `dio` | days | Inventory (incl. Goods in Transit) ÷ COGS (trailing 90 days) × 90 |
| `ccc` | days | DSO + DIO − DPO (null if any part is null) |
| `runwayMonths` | months | Cash and bank ÷ average monthly net cash outflow over the **last 3 full months**; null + `cash_positive` when cash is not falling; 0 when already overdrawn |
| `grossProfit` | money | Revenue − Cost of goods sold (analytics) |
| `netIncome` | money | Revenue − Cost of goods sold − Expenses; labelled "Net profit" (analytics) |
| `grossMarginPct` | percent | Gross profit ÷ Revenue × 100 (analytics) |
| `netMarginPct` | percent | Net income ÷ Revenue × 100 (analytics) |
| `inventoryTurnover` | ratio | COGS (12 months) ÷ average month-end GL 1200 (12 months) |
| `dio12` | days | Average month-end GL 1200 ÷ COGS (12 months) × 365 |

"Trailing 90 days" means `asOfDate − 89` to `asOfDate`.

### Assessments
`assessment: { level, guide }` on every KPI says how the figure reads against a rule of thumb. `level` is `'healthy' | 'watch' | 'risk' | 'neutral'`; `guide` is one sentence to quote beside the formula. The thresholds live only in `kpi-benchmarks.ts`, so web and app can never disagree. A client shows `level` as a pill, with an icon and a word, never colour alone. It guesses nothing when the field is missing.

| key | healthy | watch | risk |
|---|---|---|---|
| `currentRatio` | ≥ 1.5 | ≥ 1 | < 1 |
| `quickRatio` | ≥ 1 | ≥ 0.7 | < 0.7 |
| `debtToEquity` | ≤ 1 | ≤ 2 | > 2, or `negative_equity` |
| `runwayMonths` | ≥ 6, or `cash_positive` | ≥ 3 | < 3 |
| `dso` | ≤ 45 | ≤ 75 | > 75 |
| `dio`, `dio12`, `ccc` | ≤ 60 | ≤ 120 | > 120 |
| `inventoryTurnover` | ≥ 6 | ≥ 3 | < 3 |
| `overduePct` | ≤ 20 | ≤ 40 | > 40 |
| `weightedAvgDaysOverdue` | ≤ 30 | ≤ 60 | > 60 |
| `top5SharePct` | ≤ 50 | ≤ 70 | > 70 |
| `daysOfCover` (one item) | 14–60 | 7–13, or 61–120 | < 7 (0 is out of stock), or > 120 |
| `cashAndBank`, `workingCapital`, `grossProfit`, `grossMarginPct`, `netIncome`, `netMarginPct`, `endingCash` | > 0 | — | ≤ 0 |
| `operatingCashFlow` | > 0 | ≤ 0 | — |

`revenue`, `operatingExpenses` and `dpo` are always `neutral`. So is any KPI whose value is null for a reason that is not itself the verdict.

---

## Cash-flow line keys

| lineKey | section | label |
|---|---|---|
| `op.customers` | operating | Cash received from customers |
| `op.customer_refunds` | operating | Customer refunds |
| `op.suppliers` | operating | Cash paid to suppliers |
| `op.vendor_refunds` | operating | Vendor refunds received |
| `op.payroll` | operating | Payroll paid |
| `op.tax` | operating | Tax payments |
| `op.other` | operating | Other cash movements |
| `inv.fixed_assets` | investing | Purchase / sale of fixed assets |
| `fin.loans` | financing | Loan proceeds / repayments |
| `fin.owner_contributions` | financing | Owner contributions |
| `fin.owner_drawings` | financing | Owner drawings |
| `fin.opening_balance` | financing | Opening balance / owner funding |

How cash is classified: by the other lines of the same posting.
- Fixed asset → investing.
- Notes Payable → financing.
- Owner equity / opening balance equity → contributions.
- Owner Draws → drawings.
- Anything else → operating, under the line its document type always had.
- **A bill payment** is looked through to the bills it paid and split in proportion to their posted lines.
- **An `opening_balance` posting** keeps its own line.
- **A transfer** between cash and bank accounts is in no section.

---

## Client migration

| If the client does this today | Do this instead |
|---|---|
| Groups balance-sheet lines by account-number range | Render `sections[]` in order. Use `subtotals[]` for the total rows. |
| Looks for the `3100` "Net Income (current period)" line | Use `equity[]` / the equity section as returned. The current year is the line with `synthetic: 'currentYearEarnings'`; Retained Earnings carries `composite`. |
| Uses `accountCode` as a unique key for equity lines | Key on `synthetic ?? accountCode` (synthetic lines have `accountCode: ''`). |
| Parses `accountCode` as a number for sorting or grouping | Expect `''` on synthetic lines. Sort by section order, not by number. |
| Adds L + E for the "balances" check | Use `totalLiabilitiesAndEquity`, `isBalanced` and `gap`. |
| Matches cash-flow lines by `label` | Match by `lineKey`. Open a line's rows at `/cash-flow/lines/:lineKey/entries`. |
| Computes running balances on a ledger screen | Use `/accounts/:code/register` → `entries[].runningBalance`. |
| Computes ending cash per month from `monthlyTrend` | Use `monthlyTrend[].endingCash`. |
| Computes current ratio, DSO, runway… on the device | Use `/reports/financial-health` (or `analytics.kpis`). Show `formula` and `inputs` for the working. |
| Builds the owner dashboard from `/analytics-dashboard` (invoice totals) | Move to `/reports/analytics`, which is GL-based and dated. `/analytics-dashboard` is unchanged for old builds. |
| Builds a closing trial balance by summing movement | Call `/trial-balance?mode=closing` or `mode=working`. |
| Computes credit usage on aging rows | Use `creditUsedPct`, `overLimit` and `creditLimit`. |
| Reads `fiscalYearStart` from settings and the company separately | Either one; they are now the same value. |

---

## Error codes (new)

| code | when |
|---|---|
| `INVALID_DATE` | a date is not a real `YYYY-MM-DD` |
| `INVALID_RANGE` | start after end, or only one of a pair given |
| `INVALID_COMPARE_DATE` | `compareTo` is not before `asOfDate` |
| `INVALID_MODE` | trial-balance `mode` not movement, closing or working |
| `INVALID_ORDER` | register `order` not asc or desc |
| `INVALID_ACCOUNT_CODE` | the path's account code is not an account number |
| `ACCOUNT_NOT_FOUND` | no such account in this company (404) |
| `UNKNOWN_LINE_KEY` | not one of the cash-flow line keys |
| `RANGE_TOO_LONG` | analytics range over 60 months |
| `INVALID_TOP` | analytics `expenseTop` or `customerTop` is not a whole number |
| `INVALID_FISCAL_YEAR_START` | `PATCH /settings fiscalYearStart` is not a month |
