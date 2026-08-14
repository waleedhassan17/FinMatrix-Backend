/**
 * Shared enums and interfaces used across modules.
 * Populated incrementally starting in Phase 1.
 */

export type UserRole = 'admin' | 'delivery' | 'staff' | 'super_admin';

/**
 * Company onboarding/approval state machine (Stage 1).
 *
 *   unverified        -> owner signed up, email not yet verified, no company
 *   email_verified    -> owner verified email; company draft is being filled in
 *   pending_approval  -> onboarding submitted, waiting on platform admin review
 *   approved          -> platform admin approved; company admin has full access
 *   rejected          -> platform admin rejected (see rejectionReason)
 *
 * NOTE: legacy companies created before Stage 1 use the value `active`, which is
 * treated as equivalent to `approved` everywhere the login gate is evaluated.
 */
export type CompanyStatus =
  | 'unverified'
  | 'email_verified'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  // legacy values still present in older rows / seeds
  | 'active'
  | 'pending'
  | 'suspended';

export const COMPANY_STATUS = {
  UNVERIFIED: 'unverified',
  EMAIL_VERIFIED: 'email_verified',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

/** A company is usable (full app access) only when approved (or legacy active). */
export function isCompanyApproved(status: string | null | undefined): boolean {
  return status === COMPANY_STATUS.APPROVED || status === 'active';
}

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

export type JournalEntryStatus = 'draft' | 'posted' | 'void';

export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'partial'
  | 'paid'
  | 'overdue'
  | 'void';

export type BillStatus = 'draft' | 'open' | 'partial' | 'paid' | 'overdue' | 'void';

export type PaymentMethod =
  | 'cash'
  | 'check'
  | 'bank_transfer'
  | 'credit_card'
  | 'other';

export type PaymentTerms =
  | 'due_on_receipt'
  | 'net15'
  | 'net30'
  | 'net45'
  | 'net60'
  | '2_10_net30'
  | 'custom';

export type EstimateStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired';

export type SalesOrderStatus =
  | 'draft'
  | 'open'
  | 'partial'
  | 'fulfilled'
  | 'closed';

export type PurchaseOrderStatus =
  | 'draft'
  | 'sent'
  | 'partial'
  | 'received'
  | 'closed';

// ---- Module 2 ----

export type AgencyType = 'manufacturing' | 'supply' | 'distribution';

/**
 * Weighted average is the ONLY costing method this system implements.
 *
 * 'fifo' and 'lifo' used to be accepted here and stored on the item, but
 * nothing ever branched on the value: every outflow — invoice COGS,
 * credit-memo restock, delivery dispatch, inventory approvals, adjustments —
 * values stock at the item's running weighted-average unit_cost, and no cost
 * layers are tracked anywhere. Offering the other two labels misstated COGS
 * and inventory for anyone who picked one (audit gap G6).
 *
 * Reintroducing them means per-receipt cost layers consumed in order, not a
 * new enum value.
 */
export type InventoryCostMethod = 'average';

export type InventoryMovementType =
  | 'adjustment'
  | 'delivery'
  | 'receipt'
  | 'transfer'
  | 'sale'
  | 'return';

export type InventoryAdjustmentReason =
  | 'physical_count'
  | 'damage'
  | 'theft'
  | 'correction'
  | 'obsolescence'
  // Written only by reverseAdjustment (G7); not selectable by a user, and the
  // marker that stops a reversal being reversed again.
  | 'reversal'
  | 'other';

export type StockTransferStatus = 'draft' | 'in_transit' | 'completed' | 'cancelled';

export type DeliveryStatus =
  | 'unassigned'
  | 'pending'
  | 'picked_up'
  | 'in_transit'
  | 'arrived'
  | 'delivered'
  | 'failed'
  | 'returned'
  | 'cancelled';

export type DeliveryPriority = 'low' | 'normal' | 'medium' | 'high' | 'urgent';

export type DeliveryPersonnelStatus = 'active' | 'on_leave' | 'inactive';

export type DeliveryIssueType =
  | 'damaged'
  | 'wrong_item'
  | 'customer_refused'
  | 'access_denied'
  | 'payment_issue'
  | 'other';

export type InventoryRequestStatus = 'pending' | 'approved' | 'rejected';

export type ShadowSyncStatus = 'synced' | 'pending';

export type BankAccountType = 'checking' | 'savings' | 'credit_card';

export type BankTransactionType =
  | 'deposit'
  | 'check'
  | 'expense'
  | 'transfer'
  | 'fee';

export type ReconciliationStatus = 'in_progress' | 'completed';

export type EmployeeStatus = 'active' | 'on_leave' | 'terminated';

export type PayType = 'salary' | 'hourly';

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export type PayrollRunStatus = 'draft' | 'posted' | 'void';

export type BudgetStatus = 'draft' | 'active' | 'closed';

export type TaxType = 'sales' | 'purchase';

export type ReportFormat = 'json' | 'csv' | 'pdf';
