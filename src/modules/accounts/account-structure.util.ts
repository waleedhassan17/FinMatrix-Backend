/**
 * When an account's type and number may still change.
 *
 * They used to be fixed the moment an account was saved. That protects the
 * books — a posted line reads its account's type to decide which statement it
 * lands on, so retyping an account with history rewrites every report it has
 * ever appeared on — but it also meant one slip on the New Account form could
 * never be undone: "Meezan Bank" saved as an Other Expense stayed an expense,
 * and so never appeared anywhere a bank account is offered.
 *
 * So the line is drawn where it actually matters. An account nothing refers
 * to yet can be retyped and renumbered freely; once anything does — a
 * posting, a draft's line, a payment, a budget, a reconciliation, a vendor's
 * default — both are fixed, and the way forward is a new account. System
 * accounts are fixed from the start: automatic posting finds them by number
 * and expects their type and kind.
 */
export interface AccountUsage {
  /** Rows in the general ledger. */
  postings: number;
  /** Lines of draft journal entries (posted ones are counted as postings). */
  draftJournalLines: number;
  /** Invoice, estimate, sales-order, PO, bill and vendor-credit lines. */
  documentLines: number;
  /** Receipts, bill payments, tax payments, payroll runs and refunds made through it. */
  payments: number;
  /** Budget lines, reconciliations and vendors' default expense account. */
  other: number;
  /** Accounts nested under it. */
  children: number;
}

export const EMPTY_USAGE: AccountUsage = {
  postings: 0,
  draftJournalLines: 0,
  documentLines: 0,
  payments: 0,
  other: 0,
  children: 0,
};

/** Everything that pins the account's type and number, children aside. */
export const usageTotal = (u: AccountUsage): number =>
  u.postings + u.draftJournalLines + u.documentLines + u.payments + u.other;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "12 postings and 1 payment" — what holds the account in place. */
export function describeUsage(u: AccountUsage): string {
  const parts = [
    u.postings > 0 ? plural(u.postings, 'posting') : '',
    u.draftJournalLines > 0
      ? plural(u.draftJournalLines, 'draft journal line')
      : '',
    u.documentLines > 0 ? plural(u.documentLines, 'document line') : '',
    u.payments > 0 ? plural(u.payments, 'payment') : '',
    u.other > 0
      ? plural(
          u.other,
          'budget, reconciliation or vendor default',
          'budgets, reconciliations or vendor defaults',
        )
      : '',
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface AccountStructure {
  /** Whether the type and the number may change. */
  editable: boolean;
  /** Why not, in a sentence — null when they may. */
  reason: string | null;
}

/** Whether this account's type and number may change, and if not, why. */
export function structureOf(
  isSystemAccount: boolean,
  usage: AccountUsage,
): AccountStructure {
  if (isSystemAccount) {
    return {
      editable: false,
      reason:
        'A system account — automatic posting finds it by its number and type, so both are fixed.',
    };
  }
  if (usageTotal(usage) > 0) {
    return {
      editable: false,
      reason: `Already in use (${describeUsage(usage)}), so its type and number are fixed.`,
    };
  }
  if (usage.children > 0) {
    return {
      editable: false,
      reason: `It has ${plural(usage.children, 'sub-account')}. Move ${usage.children === 1 ? 'it' : 'them'} first to change its type.`,
    };
  }
  return { editable: true, reason: null };
}

/**
 * The counts behind AccountUsage, for one account (`$1` company, `$2` account).
 *
 * The line tables carry no company_id, and need none: account ids are uuids,
 * and the account has already been checked to belong to this company.
 */
export const ACCOUNT_USAGE_SQL = `
  SELECT
    (SELECT COUNT(*) FROM general_ledger WHERE company_id = $1 AND account_id = $2)::int AS postings,
    (SELECT COUNT(*) FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND e.status = 'draft' AND l.account_id = $2)::int AS "draftJournalLines",
    ((SELECT COUNT(*) FROM invoice_line_items WHERE account_id = $2)
     + (SELECT COUNT(*) FROM estimate_line_items WHERE account_id = $2)
     + (SELECT COUNT(*) FROM sales_order_line_items WHERE account_id = $2)
     + (SELECT COUNT(*) FROM purchase_order_lines WHERE account_id = $2)
     + (SELECT COUNT(*) FROM bill_line_items WHERE account_id = $2)
     + (SELECT COUNT(*) FROM vendor_credit_lines WHERE account_id = $2))::int AS "documentLines",
    ((SELECT COUNT(*) FROM payments WHERE company_id = $1 AND bank_account_id = $2)
     + (SELECT COUNT(*) FROM bill_payments WHERE company_id = $1 AND bank_account_id = $2)
     + (SELECT COUNT(*) FROM tax_payments WHERE company_id = $1 AND bank_account_id = $2)
     + (SELECT COUNT(*) FROM payroll_runs WHERE company_id = $1 AND bank_account_id = $2)
     + (SELECT COUNT(*) FROM credit_memos WHERE company_id = $1 AND refund_account_id = $2))::int AS payments,
    ((SELECT COUNT(*) FROM budget_lines WHERE account_id = $2)
     + (SELECT COUNT(*) FROM reconciliations WHERE company_id = $1 AND account_id = $2)
     + (SELECT COUNT(*) FROM vendors WHERE company_id = $1 AND default_expense_account_id = $2))::int AS other,
    (SELECT COUNT(*) FROM accounts WHERE company_id = $1 AND parent_id = $2)::int AS children`;
