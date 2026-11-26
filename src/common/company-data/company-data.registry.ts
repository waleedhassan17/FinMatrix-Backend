/**
 * THE registry of company-owned data — every table in the schema, classified.
 *
 * Deleting a company (AccountAdminService) is driven entirely from here, and
 * two tests keep it honest:
 *   - company-data.registry.spec.ts (unit, runs in CI): every TypeORM entity
 *     with a company_id column, or a relation to a company-scoped entity, is
 *     registered;
 *   - test/account-admin.acceptance.ts (database): every table in the public
 *     schema is classified here, and after a deletion every `company` and
 *     `child` table holds zero rows for that company.
 * A new table that is not added here fails one of them.
 *
 * The export registry (data-portability/exporter/export-entities.ts) is the
 * SUBSET a customer's backup contains; the spec asserts every export entity
 * is registered here too.
 */

/** A table with its own company_id: deleted WHERE company_id = $1. */
export interface CompanyTable {
  table: string;
  scope: 'company';
}

/**
 * A table with no company_id, reached through its parent document.
 * `cascade: true` — the parent's FK deletes it (counted, never deleted by hand).
 * `cascade: false` — no FK to the parent: deleted explicitly, first.
 */
export interface ChildTable {
  table: string;
  scope: 'child';
  parent: string;
  fk: string;
  cascade: boolean;
  /** Further parent links (e.g. an application points at two documents). */
  alsoVia?: Array<{ parent: string; fk: string }>;
}

/**
 * Platform-owned rows that mention a company. Never deleted with it:
 *   retain        — kept as-is (FinMatrix's own records: revenue, audit);
 *   null-columns  — the company reference is cleared, the row is kept;
 *   trial-claims  — handled by the trial rules (kept, or released).
 */
export interface PlatformTable {
  table: string;
  scope: 'platform';
  handling: 'retain' | 'null-columns' | 'trial-claims';
  columns?: string[];
}

export type CompanyDataEntry = CompanyTable | ChildTable | PlatformTable;

const company = (table: string): CompanyTable => ({ table, scope: 'company' });
const child = (
  table: string,
  parent: string,
  fk: string,
  cascade: boolean,
  alsoVia?: Array<{ parent: string; fk: string }>,
): ChildTable => ({ table, scope: 'child', parent, fk, cascade, alsoVia });

export const COMPANY_DATA_REGISTRY: CompanyDataEntry[] = [
  // ── Books and documents ──
  company('accounts'),
  company('journal_entries'),
  child('journal_entry_lines', 'journal_entries', 'entry_id', true),
  company('general_ledger'),
  company('customers'),
  company('vendors'),
  company('tax_rates'),
  company('tax_payments'),
  company('invoices'),
  child('invoice_line_items', 'invoices', 'invoice_id', true),
  company('payments'),
  child('payment_applications', 'payments', 'payment_id', true),
  company('credit_memos'),
  child('credit_memo_lines', 'credit_memos', 'credit_memo_id', true),
  child('credit_memo_applications', 'credit_memos', 'credit_memo_id', false, [
    { parent: 'invoices', fk: 'invoice_id' },
  ]),
  company('estimates'),
  child('estimate_line_items', 'estimates', 'estimate_id', true),
  company('sales_orders'),
  child('sales_order_line_items', 'sales_orders', 'sales_order_id', true),
  company('bills'),
  child('bill_line_items', 'bills', 'bill_id', true),
  company('bill_payments'),
  child('bill_payment_applications', 'bill_payments', 'bill_payment_id', true),
  company('bill_payment_proofs'),
  company('vendor_credits'),
  child('vendor_credit_lines', 'vendor_credits', 'vendor_credit_id', true),
  company('purchase_orders'),
  child('purchase_order_lines', 'purchase_orders', 'order_id', true),
  company('budgets'),
  child('budget_lines', 'budgets', 'budget_id', true),
  company('reconciliations'),
  company('bank_accounts'),
  company('bank_transactions'),
  company('employees'),
  company('payroll_runs'),
  child('payroll_items', 'payroll_runs', 'payroll_run_id', true),
  child('paystubs', 'payroll_runs', 'payroll_run_id', true),
  company('document_sequences'),
  company('agencies'),
  company('approval_requests'),

  // ── Inventory ──
  company('inventory_items'),
  company('inventory_item_images'),
  company('inventory_locations'),
  company('inventory_movements'),
  company('inventory_adjustments'),
  company('physical_counts'),
  child('physical_count_lines', 'physical_counts', 'count_id', true),
  company('stock_transfers'),
  child('stock_transfer_lines', 'stock_transfers', 'transfer_id', true),
  company('inventory_update_requests'),
  child(
    'inventory_update_request_lines',
    'inventory_update_requests',
    'request_id',
    true,
  ),
  company('inventory_approval_audit_entries'),
  company('shadow_inventory_snapshots'),

  // ── Deliveries ──
  company('deliveries'),
  child('delivery_items', 'deliveries', 'delivery_id', true),
  child('delivery_issues', 'deliveries', 'delivery_id', false),
  child('delivery_location_logs', 'deliveries', 'delivery_id', false),
  child('delivery_signatures', 'deliveries', 'delivery_id', false),
  child('delivery_status_history', 'deliveries', 'delivery_id', false),
  company('delivery_personnel_profiles'),

  // ── Messaging ──
  company('company_messaging_settings'),
  company('messaging_usage'),
  company('outbound_messages'),
  child('message_status_events', 'outbound_messages', 'message_id', true),

  // ── Migration Center, backups ──
  company('migration_batches'),
  company('migration_batch_records'),
  company('migration_files'),
  company('migration_issues'),
  company('migration_mappings'),
  company('migration_profiles'),
  company('migration_staging_rows'),
  company('migration_uploads'),
  child('migration_upload_parts', 'migration_uploads', 'upload_id', true),
  company('company_exports'),

  // ── Settings, access, history ──
  company('company_settings'),
  company('company_subscriptions'),
  company('platform_payment_submissions'),
  company('managed_credentials'),
  company('user_companies'),
  company('notifications'),
  company('audit_trail'),
  company('operational_audit_events'),
  company('idempotency_records'),

  // ── Platform-owned, kept ──
  { table: 'platform_revenue', scope: 'platform', handling: 'retain' },
  { table: 'platform_audit_events', scope: 'platform', handling: 'retain' },
  {
    table: 'trial_attempts',
    scope: 'platform',
    handling: 'null-columns',
    columns: ['company_id'],
  },
  {
    table: 'demo_requests',
    scope: 'platform',
    handling: 'null-columns',
    columns: ['converted_company_id'],
  },
  { table: 'trial_claims', scope: 'platform', handling: 'trial-claims' },
];

/**
 * Tables that hold no company data at all (or ARE the company / the user).
 * Listed so the database test can insist every table is classified.
 */
export const NON_COMPANY_TABLES: string[] = [
  'companies', // the row itself, deleted last
  'users', // deleted when this company was their only membership
  'refresh_tokens',
  'revoked_access_tokens',
  'email_verifications',
  'password_resets',
  'password_reset_otps',
  'stored_files', // reached through the file-key columns below
  'subscription_plans',
  'plan_overrides',
  'migrations',
  'company_deletions',
  'platform_final_backups',
  'demo_request_notes',
];

/**
 * Columns holding a StorageService key (`cld:…`, `db:…` or a disk path) for a
 * file the company owns. Collected before the rows go; `db:` files are deleted
 * in the same transaction, the rest after it commits.
 */
export const COMPANY_FILE_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'bill_payment_proofs', column: 'storage_key' },
  { table: 'bill_payments', column: 'proof_storage_key' },
  { table: 'company_exports', column: 'storage_key' },
  { table: 'deliveries', column: 'bill_photo_storage_key' },
  { table: 'inventory_item_images', column: 'storage_key' },
  { table: 'inventory_item_images', column: 'thumb_storage_key' },
  {
    table: 'inventory_update_requests',
    column: 'proof_bill_photo_storage_key',
  },
  { table: 'migration_batches', column: 'certificate_storage_key' },
  { table: 'migration_files', column: 'storage_key' },
  { table: 'outbound_messages', column: 'media_storage_key' },
  { table: 'platform_payment_submissions', column: 'screenshot_key' },
];

export const companyTables = (): CompanyTable[] =>
  COMPANY_DATA_REGISTRY.filter((e): e is CompanyTable => e.scope === 'company');

export const childTables = (): ChildTable[] =>
  COMPANY_DATA_REGISTRY.filter((e): e is ChildTable => e.scope === 'child');

export const platformTables = (): PlatformTable[] =>
  COMPANY_DATA_REGISTRY.filter(
    (e): e is PlatformTable => e.scope === 'platform',
  );

export const registeredTableNames = (): Set<string> =>
  new Set([
    ...COMPANY_DATA_REGISTRY.map((e) => e.table),
    ...NON_COMPANY_TABLES,
  ]);
