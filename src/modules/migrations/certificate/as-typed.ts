/**
 * "Figures as you typed them": the before-and-after statement on the
 * certificate. For every trial-balance line, open invoice, open bill and
 * stock row that will be imported, the text exactly as it stood in the file,
 * what FinMatrix read it as, and (after a practice or real import) what the
 * books now hold. The owner compares the first column with their old
 * system; the checks compare the other two.
 */

export interface AsTypedActuals {
  /** Account number → balance as stored, with the account's type. */
  accountBalance: Map<string, { balance: string; type: string }>;
  /** `${kind}:${id}` reference → party balance. */
  partyBalance: Map<string, string>;
  /** `${kind}:${id}` reference → quantity on hand and unit cost. */
  item: Map<string, { quantity: string; cost: string }>;
}

export interface AsTypedTrialBalanceRow {
  account: string;
  name: string;
  debitText: string;
  creditText: string;
  readAs: string;
  posted: string | null;
}

export interface AsTypedOpenItemRow {
  kind: 'invoice' | 'bill';
  party: string;
  document: string;
  asTyped: string;
  readAs: string;
  partyBalance: string | null;
}

export interface AsTypedStockRow {
  sku: string;
  quantityText: string;
  costText: string;
  readAs: string;
  onHand: string | null;
}

export interface AsTypedFigures {
  trialBalance: AsTypedTrialBalanceRow[];
  openItems: AsTypedOpenItemRow[];
  stock: AsTypedStockRow[];
  /** Rows beyond the per-table limit, so the certificate can say so. */
  more: { trialBalance: number; openItems: number; stock: number };
}

type StagingLike = {
  entityType: string | null;
  outcome: string;
  normalized: Record<string, unknown> | null;
};

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const refKey = (v: unknown): string | null => {
  const r = v as { kind?: unknown; id?: unknown } | null | undefined;
  return r && r.kind !== undefined && r.id !== undefined
    ? `${String(r.kind)}:${String(r.id)}`
    : null;
};

const DEBIT_NATURE = new Set(['asset', 'expense']);

export function buildAsTyped(
  staging: StagingLike[],
  actuals: AsTypedActuals | null,
  limit = 200,
): AsTypedFigures {
  const imported = (type: string) =>
    staging.filter((r) => r.entityType === type && r.outcome === 'imported');
  const n = (r: StagingLike) => r.normalized ?? {};

  const trialBalance: AsTypedTrialBalanceRow[] = [];
  for (const r of imported('trial_balance')) {
    const v = n(r);
    const target = text(v.targetAccount);
    const account =
      target && target !== 'NEW' && !target.startsWith('NEW:')
        ? target
        : text(v.accountNumber);
    const debit = text(v.debit);
    const credit = text(v.credit);
    const readAs = [debit && `Dr ${debit}`, credit && `Cr ${credit}`]
      .filter(Boolean)
      .join(' / ');
    const acct = actuals?.accountBalance.get(account);
    trialBalance.push({
      account,
      name: text(v.accountName),
      debitText: text(v.debitText),
      creditText: text(v.creditText),
      readAs,
      posted: acct
        ? `${DEBIT_NATURE.has(acct.type) ? 'Dr' : 'Cr'} ${acct.balance}`
        : null,
    });
  }

  const openItems: AsTypedOpenItemRow[] = [];
  for (const [type, kind, party, doc, ref] of [
    ['open_invoices', 'invoice', 'customer', 'invoiceNumber', 'customerRef'],
    ['open_bills', 'bill', 'vendor', 'billNumber', 'vendorRef'],
  ] as const) {
    for (const r of imported(type)) {
      const v = n(r);
      const key = refKey(v[ref]);
      openItems.push({
        kind,
        party: text(v[party]),
        document: text(v[doc]),
        asTyped: text(v.amountDueText),
        readAs: text(v.amountDue),
        partyBalance:
          key && actuals ? (actuals.partyBalance.get(key) ?? null) : null,
      });
    }
  }

  const stock: AsTypedStockRow[] = [];
  for (const r of imported('stock')) {
    const v = n(r);
    const key = refKey(v.skuRef);
    const item = key && actuals ? actuals.item.get(key) : undefined;
    stock.push({
      sku: text(v.sku),
      quantityText: text(v.quantityOnHandText),
      costText: text(v.unitCostText),
      readAs: `${text(v.quantityOnHand)} × ${text(v.unitCost)}`,
      onHand: item ? `${item.quantity} × ${item.cost}` : null,
    });
  }

  return {
    trialBalance: trialBalance.slice(0, limit),
    openItems: openItems.slice(0, limit),
    stock: stock.slice(0, limit),
    more: {
      trialBalance: Math.max(0, trialBalance.length - limit),
      openItems: Math.max(0, openItems.length - limit),
      stock: Math.max(0, stock.length - limit),
    },
  };
}
