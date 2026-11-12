import {
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  SelectQueryBuilder,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Customer } from '../../customers/entities/customer.entity';
import { Vendor } from '../../vendors/entities/vendor.entity';
import { InventoryItem } from '../../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../../inventory/entities/inventory-movement.entity';
import { InventoryAdjustment } from '../../inventory/entities/inventory-adjustment.entity';
import { Invoice } from '../../invoices/entities/invoice.entity';
import { InvoiceLineItem } from '../../invoices/entities/invoice-line-item.entity';
import { Payment } from '../../payments/entities/payment.entity';
import { PaymentApplication } from '../../payments/entities/payment-application.entity';
import { Bill } from '../../bills/entities/bill.entity';
import { BillLineItem } from '../../bills/entities/bill-line-item.entity';
import { BillPayment } from '../../bills/entities/bill-payment.entity';
import { BillPaymentApplication } from '../../bills/entities/bill-payment-application.entity';
import { CreditMemo } from '../../credit-memos/entities/credit-memo.entity';
import { CreditMemoLine } from '../../credit-memos/entities/credit-memo-line.entity';
import { VendorCredit } from '../../vendor-credits/entities/vendor-credit.entity';
import { VendorCreditLine } from '../../vendor-credits/entities/vendor-credit-line.entity';
import { Estimate } from '../../estimates/entities/estimate.entity';
import { EstimateLineItem } from '../../estimates/entities/estimate-line-item.entity';
import { SalesOrder } from '../../sales-orders/entities/sales-order.entity';
import { SalesOrderLineItem } from '../../sales-orders/entities/sales-order-line-item.entity';
import { PurchaseOrder } from '../../purchase-orders/entities/purchase-order.entity';
import { PurchaseOrderLine } from '../../purchase-orders/entities/purchase-order-line.entity';
import { Delivery } from '../../deliveries/entities/delivery.entity';
import { DeliveryItem } from '../../deliveries/entities/delivery-item.entity';
import { JournalEntry } from '../../journal-entries/entities/journal-entry.entity';
import { JournalEntryLine } from '../../journal-entries/entities/journal-entry-line.entity';
import { GeneralLedgerEntry } from '../../ledger/entities/general-ledger.entity';
import { TaxRate } from '../../tax/entities/tax-rate.entity';
import { TaxPayment } from '../../tax/entities/tax-payment.entity';
import { Budget } from '../../budgets/entities/budget.entity';
import { BudgetLine } from '../../budgets/entities/budget-line.entity';
import { Employee } from '../../payroll/entities/employee.entity';
import { PayrollRun } from '../../payroll/entities/payroll-run.entity';
import { PayrollItem } from '../../payroll/entities/payroll-item.entity';

/**
 * How a table is tied to its tenant.
 *
 *   company — the row carries company_id itself (BaseCompanyEntity).
 *   parent  — a line table (invoice_line_items, journal_entry_lines, …) that
 *             has no company_id of its own and is reached ONLY through its
 *             company-scoped parent: `fk IN (SELECT id FROM parent WHERE
 *             company_id = ?)`.
 */
export type ExportScope =
  | { kind: 'company' }
  | {
      kind: 'parent';
      parent: EntityTarget<ObjectLiteral>;
      /** Property name of the foreign key on the child, e.g. `invoiceId`. */
      foreignKey: string;
    };

export interface ExportEntityDef {
  /** File name without extension, XLSX sheet name and manifest key. */
  name: string;
  entity: EntityTarget<ObjectLiteral>;
  scope: ExportScope;
  /** Property names left out of the file. */
  omit?: readonly string[];
}

const company: ExportScope = { kind: 'company' };
const via = (
  parent: EntityTarget<ObjectLiteral>,
  foreignKey: string,
): ExportScope => ({ kind: 'parent', parent, foreignKey });

/**
 * Everything a company backup contains, in the order the files are written.
 *
 * The single registry: a table missing from a backup is fixed by adding one
 * line here. Columns are read from TypeORM's metadata at export time, so a new
 * column on any of these entities is in the next backup with no change here.
 * Parents come before their lines so a reader who opens the ZIP in order sees
 * the document before its detail.
 */
export const EXPORT_ENTITIES: readonly ExportEntityDef[] = [
  { name: 'accounts', entity: Account, scope: company },
  { name: 'customers', entity: Customer, scope: company },
  { name: 'vendors', entity: Vendor, scope: company },
  { name: 'items', entity: InventoryItem, scope: company },
  { name: 'tax_rates', entity: TaxRate, scope: company },

  { name: 'invoices', entity: Invoice, scope: company },
  {
    name: 'invoice_lines',
    entity: InvoiceLineItem,
    scope: via(Invoice, 'invoiceId'),
  },
  { name: 'payments', entity: Payment, scope: company },
  {
    name: 'payment_allocations',
    entity: PaymentApplication,
    scope: via(Payment, 'paymentId'),
  },
  { name: 'credit_memos', entity: CreditMemo, scope: company },
  {
    name: 'credit_memo_lines',
    entity: CreditMemoLine,
    scope: via(CreditMemo, 'creditMemoId'),
  },
  { name: 'estimates', entity: Estimate, scope: company },
  {
    name: 'estimate_lines',
    entity: EstimateLineItem,
    scope: via(Estimate, 'estimateId'),
  },
  { name: 'sales_orders', entity: SalesOrder, scope: company },
  {
    name: 'sales_order_lines',
    entity: SalesOrderLineItem,
    scope: via(SalesOrder, 'salesOrderId'),
  },
  { name: 'deliveries', entity: Delivery, scope: company },
  {
    name: 'delivery_items',
    entity: DeliveryItem,
    scope: via(Delivery, 'deliveryId'),
  },

  { name: 'bills', entity: Bill, scope: company },
  { name: 'bill_lines', entity: BillLineItem, scope: via(Bill, 'billId') },
  { name: 'bill_payments', entity: BillPayment, scope: company },
  {
    name: 'bill_payment_allocations',
    entity: BillPaymentApplication,
    scope: via(BillPayment, 'billPaymentId'),
  },
  { name: 'vendor_credits', entity: VendorCredit, scope: company },
  {
    name: 'vendor_credit_lines',
    entity: VendorCreditLine,
    scope: via(VendorCredit, 'vendorCreditId'),
  },
  { name: 'purchase_orders', entity: PurchaseOrder, scope: company },
  {
    name: 'purchase_order_lines',
    entity: PurchaseOrderLine,
    scope: via(PurchaseOrder, 'orderId'),
  },
  { name: 'tax_payments', entity: TaxPayment, scope: company },

  { name: 'journal_entries', entity: JournalEntry, scope: company },
  {
    name: 'journal_lines',
    entity: JournalEntryLine,
    scope: via(JournalEntry, 'entryId'),
  },
  { name: 'general_ledger', entity: GeneralLedgerEntry, scope: company },

  { name: 'stock_movements', entity: InventoryMovement, scope: company },
  {
    name: 'inventory_adjustments',
    entity: InventoryAdjustment,
    scope: company,
  },

  { name: 'budgets', entity: Budget, scope: company },
  { name: 'budget_lines', entity: BudgetLine, scope: via(Budget, 'budgetId') },
  { name: 'employees', entity: Employee, scope: company },
  { name: 'payroll_runs', entity: PayrollRun, scope: company },
  {
    name: 'payroll_items',
    entity: PayrollItem,
    scope: via(PayrollRun, 'payrollRunId'),
  },
];

export interface ExportColumn {
  /** Entity property, read off the loaded row. */
  property: string;
  /** Database column name — the CSV header, so a backup reads like the schema. */
  header: string;
}

/** The exported columns of a registry entry, in declaration order. */
export function exportColumns(
  manager: EntityManager,
  def: ExportEntityDef,
): ExportColumn[] {
  const meta = manager.connection.getMetadata(def.entity);
  const omit = new Set(def.omit ?? []);
  return meta.columns
    .filter((c) => !omit.has(c.propertyName))
    .map((c) => ({ property: c.propertyPath, header: c.databaseName }));
}

/** Pages are read by primary key so a 1.25M-row ledger never sits in memory. */
export const EXPORT_PAGE_SIZE = 2_000;

/**
 * The ONLY way this module reads a table: a query builder already filtered to
 * one company. A missing companyId is a programming error and throws before
 * any SQL runs — no query in a backup can be unscoped by accident.
 */
export function scopedQuery(
  manager: EntityManager,
  def: ExportEntityDef,
  companyId: string,
): SelectQueryBuilder<ObjectLiteral> {
  if (!companyId || typeof companyId !== 'string') {
    throw new Error(
      `Export of ${def.name} requires a companyId; refusing an unscoped query`,
    );
  }
  const qb = manager.createQueryBuilder(def.entity, 'e');
  if (def.scope.kind === 'company') {
    qb.where('e.companyId = :companyId', { companyId });
  } else {
    const parent = manager.connection.getMetadata(def.scope.parent);
    qb.where(
      `e.${def.scope.foreignKey} IN (SELECT p.id FROM ${parent.tableName} p WHERE p.company_id = :companyId)`,
      { companyId },
    );
  }
  return qb.orderBy('e.id', 'ASC');
}

/** Rows of one entity for one company, a page at a time, in id order. */
export async function* iterateExportRows(
  manager: EntityManager,
  def: ExportEntityDef,
  companyId: string,
  pageSize = EXPORT_PAGE_SIZE,
): AsyncGenerator<ObjectLiteral[]> {
  let after: string | null = null;
  for (;;) {
    const qb = scopedQuery(manager, def, companyId).limit(pageSize);
    if (after) qb.andWhere('e.id > :after', { after });
    const rows = await qb.getMany();
    if (rows.length === 0) return;
    yield rows;
    after = String(rows[rows.length - 1].id);
    if (rows.length < pageSize) return;
  }
}

/** Plain SQL for the same scope — used by tests to cross-check row counts. */
export function countSql(
  manager: EntityManager,
  def: ExportEntityDef,
): { sql: string; table: string } {
  const meta = manager.connection.getMetadata(def.entity);
  if (def.scope.kind === 'company') {
    return {
      table: meta.tableName,
      sql: `SELECT COUNT(*)::int AS n FROM ${meta.tableName} WHERE company_id = $1`,
    };
  }
  const parent = manager.connection.getMetadata(def.scope.parent);
  const fk = meta.findColumnWithPropertyName(def.scope.foreignKey);
  if (!fk)
    throw new Error(`${def.name}: no column for ${def.scope.foreignKey}`);
  return {
    table: meta.tableName,
    sql: `SELECT COUNT(*)::int AS n FROM ${meta.tableName} c WHERE c.${fk.databaseName} IN (SELECT id FROM ${parent.tableName} WHERE company_id = $1)`,
  };
}
