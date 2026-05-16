/**
 * Shared enums and interfaces used across modules.
 * Populated incrementally starting in Phase 1.
 */

export type UserRole = 'admin' | 'delivery' | 'staff' | 'super_admin';

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
  | '2_10_net30';

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

export type InventoryCostMethod = 'fifo' | 'lifo' | 'average';

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
