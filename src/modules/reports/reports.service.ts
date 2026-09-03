import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { TaxPayment } from '../tax/entities/tax-payment.entity';
import type {
  CashFlowLine,
  CashFlowReport,
  OperatingIndirect,
  PnlLine,
  ProfitLossReport,
} from './reports.types';

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => parseFloat(v ?? '0') || 0;

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Invoice) private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(InventoryItem) private readonly itemRepo: Repository<InventoryItem>,
    @InjectRepository(InventoryMovement) private readonly moveRepo: Repository<InventoryMovement>,
    @InjectRepository(Delivery) private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(TaxPayment) private readonly taxRepo: Repository<TaxPayment>,
    private readonly dataSource: DataSource,
  ) {}

  private async sum(table: 'invoices' | 'bills', col: string, companyId: string, dateCol?: string, s?: string, e?: string) {
    let sql = `SELECT COALESCE(SUM(${col}::numeric),0) AS total FROM ${table} WHERE company_id=$1 AND status NOT IN ('void','draft')`;
    const params: any[] = [companyId];
    if (dateCol && s && e) { sql += ` AND ${dateCol} BETWEEN $2 AND $3`; params.push(s, e); }
    const rows = await this.dataSource.query(sql, params);
    return num(rows[0]?.total);
  }

  // ── Profit & Loss ────────────────────────────────────────────────
  /**
   * GL movements grouped by account within a date range, joined to the chart of
   * accounts. This is the single ledger-derived source the financial statements
   * (P&L, Balance Sheet, Trial Balance) compute from — never document tables —
   * so every number traces back to a posted journal entry (FinMatrixGuide §5.2).
   */
  private async glByAccount(
    companyId: string,
    startDate: string,
    endDate: string,
  ): Promise<
    {
      accountNumber: string;
      accountName: string;
      type: string;
      subType: string;
      dr: string;
      cr: string;
    }[]
  > {
    return this.dataSource.query(
      `SELECT a.account_number AS "accountNumber", a.name AS "accountName",
              a.type AS "type", a.sub_type AS "subType",
              COALESCE(SUM(g.debit::numeric), 0) AS dr,
              COALESCE(SUM(g.credit::numeric), 0) AS cr
       FROM accounts a
       LEFT JOIN general_ledger g
         ON g.account_id = a.id AND g.company_id = $1
         AND g.date >= $2 AND g.date <= $3
       WHERE a.company_id = $1
       GROUP BY a.id, a.account_number, a.name, a.type, a.sub_type
       ORDER BY a.account_number`,
      [companyId, startDate, endDate],
    );
  }

  private isCogs(row: { accountNumber: string; subType: string }): boolean {
    return row.subType === 'Cost of Goods' || row.accountNumber.startsWith('5');
  }

  /**
   * NON-operating income or expense — interest, FX, disposals, one-offs.
   * Kept out of the operating subtotal so `netOperatingIncome` reflects the
   * trade the business actually runs. Mirrors isCogs: number prefix first,
   * explicit subType as the escape hatch for a custom chart.
   */
  private isOther(row: { accountNumber: string; subType: string }): boolean {
    return (
      row.accountNumber.startsWith('7') ||
      row.accountNumber.startsWith('8') ||
      row.subType === 'Other Income' ||
      row.subType === 'Other Expense'
    );
  }

  /**
   * Sort by account code and drop untouched accounts, which would otherwise
   * pad the statement with a row of zeros for every account in the chart.
   */
  private toLines(
    rows: Array<{ accountNumber: string; accountName: string; amount: number }>,
  ): PnlLine[] {
    return rows
      .filter((r) => Math.abs(r.amount) > 0.005)
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber))
      .map((r) => ({
        accountCode: r.accountNumber,
        accountName: r.accountName,
        amount: r2(r.amount),
      }));
  }

  /**
   * Period net income from GL rows, using the SAME revenue/expense rules as
   * profitLoss(). Shared so the two statements cannot drift apart.
   */
  private netIncomeFrom(
    rows: Array<{
      type: string;
      dr: string;
      cr: string;
      accountNumber: string;
      subType: string;
    }>,
  ): number {
    let revenue = 0;
    let expense = 0;
    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') expense += dr - cr;
    }
    return r2(revenue - expense);
  }

  /**
   * Closing balance per account code as of a date, normal-balance aware:
   * positive means a debit balance for assets/expenses and a credit balance
   * for liabilities/equity/revenue.
   */
  private async balancesAsOf(
    companyId: string,
    asOf: string,
  ): Promise<Map<string, { type: string; subType: string; balance: number }>> {
    const rows = await this.glByAccount(companyId, '1970-01-01', asOf);
    const out = new Map<
      string,
      { type: string; subType: string; balance: number }
    >();
    for (const r of rows) {
      const dr = num(r.dr);
      const cr = num(r.cr);
      const balance =
        r.type === 'asset' || r.type === 'expense' ? dr - cr : cr - dr;
      out.set(r.accountNumber, { type: r.type, subType: r.subType, balance });
    }
    return out;
  }

  // ── Profit & Loss (ledger-derived) ───────────────────────────────
  async profitLoss(
    companyId: string,
    startDate: string,
    endDate: string,
  ): Promise<ProfitLossReport> {
    const s = startDate || '1970-01-01';
    const e = endDate || '2999-12-31';
    const rows = await this.glByAccount(companyId, s, e);

    // The existing five totals, computed exactly as before so their values do
    // not move. `revenue` and `expenses` stay all-inclusive; the operating-only
    // figures live in the new totals below.
    let revenue = 0;
    let cogs = 0;
    let expenses = 0;

    // The same pass now also keeps the per-account detail glByAccount already
    // returned and profitLoss used to discard.
    type Row = { accountNumber: string; accountName: string; amount: number };
    const income: Row[] = [];
    const cogsRows: Row[] = [];
    const expenseRows: Row[] = [];
    const otherIncomeRows: Row[] = [];
    const otherExpenseRows: Row[] = [];

    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      const line = (amount: number): Row => ({
        accountNumber: row.accountNumber,
        accountName: row.accountName,
        amount,
      });

      if (row.type === 'revenue') {
        const amt = cr - dr;
        revenue += amt;
        (this.isOther(row) ? otherIncomeRows : income).push(line(amt));
      } else if (row.type === 'expense') {
        const amt = dr - cr;
        if (this.isCogs(row)) {
          cogs += amt;
          cogsRows.push(line(amt));
        } else {
          expenses += amt;
          (this.isOther(row) ? otherExpenseRows : expenseRows).push(line(amt));
        }
      }
    }

    const grossProfit = r2(revenue - cogs);
    const netIncome = r2(grossProfit - expenses);

    const sum = (rs: Row[]) => rs.reduce((t, r) => t + r.amount, 0);
    const totalIncome = r2(sum(income));
    const totalCogs = r2(sum(cogsRows));
    const totalExpenses = r2(sum(expenseRows));
    const netOperatingIncome = r2(grossProfit - totalExpenses);
    const netOtherIncome = r2(sum(otherIncomeRows) - sum(otherExpenseRows));

    return {
      range: { startDate: s, endDate: e },
      comparisonRange: null,
      // ── existing fields, unchanged ──
      revenue: r2(revenue),
      cogs: r2(cogs),
      grossProfit,
      expenses: r2(expenses),
      netIncome,
      // ── added: per-account detail + operating / non-operating split ──
      income: this.toLines(income),
      cogsLines: this.toLines(cogsRows),
      expenseLines: this.toLines(expenseRows),
      otherIncome: this.toLines(otherIncomeRows),
      otherExpense: this.toLines(otherExpenseRows),
      totalIncome,
      totalCogs,
      totalExpenses,
      netOperatingIncome,
      netOtherIncome,
    };
  }

  // ── Balance Sheet (ledger-derived, as of date) ───────────────────
  async balanceSheet(companyId: string, asOfDate: string) {
    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    const rows = await this.glByAccount(companyId, '1970-01-01', asOf);

    const assets: { accountCode: string; accountName: string; amount: number }[] = [];
    const liabilities: { accountCode: string; accountName: string; amount: number }[] = [];
    const equity: { accountCode: string; accountName: string; amount: number }[] = [];
    let revenue = 0;
    let expense = 0;
    // Footed from the UNROUNDED figures — see the note above the totals.
    let rawAssets = 0;
    let rawLiabilities = 0;
    let rawEquity = 0;

    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      const line = (amount: number) => ({
        accountCode: row.accountNumber,
        accountName: row.accountName,
        amount: r2(amount),
      });
      if (row.type === 'asset') {
        const amt = dr - cr;
        if (Math.abs(amt) > 0.0001) {
          assets.push(line(amt));
          rawAssets += amt;
        }
      } else if (row.type === 'liability') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) {
          liabilities.push(line(amt));
          rawLiabilities += amt;
        }
      } else if (row.type === 'equity') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) {
          equity.push(line(amt));
          rawEquity += amt;
        }
      } else if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') expense += dr - cr;
    }

    // Current-period earnings (revenue − expense) roll into equity so the sheet
    // balances (FinMatrixGuide §5.3); shown as a Retained Earnings line.
    const rawNetIncome = revenue - expense;
    const netIncome = r2(rawNetIncome);
    if (Math.abs(netIncome) > 0.0001) {
      equity.push({
        accountCode: '3100',
        accountName: 'Net Income (current period)',
        amount: netIncome,
      });
      rawEquity += rawNetIncome;
    }

    // Foot the sections from the UNROUNDED amounts, then round once.
    //
    // Adding up the rounded line items instead lets the statement fail to
    // balance: Σ round(x) is not round(Σ x), and the ledger carries four
    // decimals, so each line can hide up to half a paisa that compounds across
    // thirty-odd accounts. The lines stay rounded for presentation — only the
    // arithmetic that has to tie is done at full precision. Every posted entry
    // balances, so A = L + E holds exactly on the raw figures.
    const totalAssets = r2(rawAssets);
    const totalLiabilities = r2(rawLiabilities);
    const totalEquity = r2(rawEquity);
    return {
      asOfDate: asOf,
      assets,
      liabilities,
      equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    };
  }

  // ── A/R Aging (bucketed) ─────────────────────────────────────────
  async arAging(companyId: string) {
    const asOf = new Date();
    const rowsRaw = await this.dataSource.query(
      `SELECT i.customer_id AS "customerId", c.name AS "customerName", i.balance::numeric AS balance, i.due_date AS "dueDate"
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id=$1 AND i.balance::numeric > 0 AND i.status NOT IN ('paid','void','draft')`, [companyId]);
    return this.bucketAging(rowsRaw, asOf, 'customerId', 'customerName');
  }

  async apAging(companyId: string) {
    const asOf = new Date();
    const rowsRaw = await this.dataSource.query(
      `SELECT b.vendor_id AS "customerId", v.company_name AS "customerName", b.balance::numeric AS balance, b.due_date AS "dueDate"
       FROM bills b JOIN vendors v ON v.id = b.vendor_id
       WHERE b.company_id=$1 AND b.balance::numeric > 0 AND b.status NOT IN ('paid','void','draft')`, [companyId]);
    return this.bucketAging(rowsRaw, asOf, 'customerId', 'customerName');
  }

  private bucketAging(rowsRaw: any[], asOf: Date, idKey: string, nameKey: string) {
    const map = new Map<string, any>();
    const blank = () => ({ current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucket90Plus: 0, total: 0 });
    for (const row of rowsRaw) {
      const id = row[idKey];
      const name = row[nameKey] ?? 'Unknown';
      const bal = num(row.balance);
      const due = new Date(row.dueDate);
      const age = Math.floor((asOf.getTime() - due.getTime()) / 86400000);
      if (!map.has(id)) map.set(id, { customerId: id, customerName: name, ...blank() });
      const e = map.get(id);
      if (age <= 0) e.current += bal;
      else if (age <= 30) e.bucket1to30 += bal;
      else if (age <= 60) e.bucket31to60 += bal;
      else if (age <= 90) e.bucket61to90 += bal;
      else e.bucket90Plus += bal;
      e.total += bal;
    }
    const rows = Array.from(map.values()).map((e) => ({
      ...e,
      current: r2(e.current), bucket1to30: r2(e.bucket1to30), bucket31to60: r2(e.bucket31to60),
      bucket61to90: r2(e.bucket61to90), bucket90Plus: r2(e.bucket90Plus), total: r2(e.total),
    })).sort((a, b) => b.total - a.total);
    const totals = rows.reduce((t, e) => ({
      current: t.current + e.current, bucket1to30: t.bucket1to30 + e.bucket1to30,
      bucket31to60: t.bucket31to60 + e.bucket31to60, bucket61to90: t.bucket61to90 + e.bucket61to90,
      bucket90Plus: t.bucket90Plus + e.bucket90Plus, total: t.total + e.total,
    }), { current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucket90Plus: 0, total: 0 });
    Object.keys(totals).forEach((k) => ((totals as any)[k] = r2((totals as any)[k])));
    return { asOfDate: asOf.toISOString().slice(0, 10), rows, totals };
  }

  // ── Inventory Valuation ──────────────────────────────────────────
  async inventoryValuation(companyId: string) {
    const items = await this.itemRepo.find({ where: { companyId } });
    const rows = items.map((it) => {
      const qty = num(it.quantityOnHand);
      const cost = num(it.unitCost);
      return { itemId: it.id, itemName: it.name, sku: it.sku, category: it.category ?? 'Uncategorized', qty, cost, value: r2(qty * cost) };
    }).sort((a, b) => b.value - a.value);
    const catMap = new Map<string, number>();
    for (const row of rows) catMap.set(row.category, (catMap.get(row.category) ?? 0) + row.value);
    const byCategory = Array.from(catMap.entries()).map(([category, totalValue]) => ({ category, totalValue: r2(totalValue) }));
    const totalValue = r2(rows.reduce((a, x) => a + x.value, 0));
    return { rows, byCategory, totalValue };
  }

  // ── Delivery Daily ───────────────────────────────────────────────
  async deliveryDaily(companyId: string) {
    const deliveries = await this.dataSource.query(
      `SELECT d.status, d.personnel_id AS "personnelId", d.zone, u.display_name AS "personnelName"
       FROM deliveries d LEFT JOIN users u ON u.id = d.personnel_id WHERE d.company_id=$1`, [companyId]);
    const total = deliveries.length;
    const completed = deliveries.filter((d: any) => d.status === 'delivered').length;
    const failed = deliveries.filter((d: any) => d.status === 'failed').length;
    const onTimePercent = total > 0 ? r2((completed / total) * 100) : 0;

    const pMap = new Map<string, any>();
    for (const d of deliveries) {
      if (!d.personnelId) continue;
      if (!pMap.has(d.personnelId)) pMap.set(d.personnelId, { personId: d.personnelId, name: d.personnelName ?? 'Unassigned', total: 0, delivered: 0, failed: 0, onTimeRate: 0 });
      const e = pMap.get(d.personnelId);
      e.total++;
      if (d.status === 'delivered') e.delivered++;
      if (d.status === 'failed') e.failed++;
    }
    const personnelStats = Array.from(pMap.values()).map((e) => ({ ...e, onTimeRate: e.total > 0 ? r2((e.delivered / e.total) * 100) : 0 }));

    const zMap = new Map<string, number>();
    for (const d of deliveries) { const z = d.zone ?? 'Unassigned'; zMap.set(z, (zMap.get(z) ?? 0) + 1); }
    const agencyDistribution = Array.from(zMap.entries()).map(([z, count]) => ({ agencyId: z, agencyName: z, count }));

    return { date: new Date().toISOString().slice(0, 10), total, completed, failed, onTimePercent, personnelStats, agencyDistribution };
  }

  // ── Delivery Performance ─────────────────────────────────────────
  async deliveryPerformance(companyId: string) {
    const daily = await this.deliveryDaily(companyId);
    const rows = daily.personnelStats;
    // Build a 7-day trend from delivery completion/created dates
    const trendRaw = await this.dataSource.query(
      `SELECT COALESCE(to_char(d.completed_at,'Dy'), to_char(d.created_at,'Dy')) AS label,
              SUM(CASE WHEN d.status='delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END) AS failed
       FROM deliveries d WHERE d.company_id=$1
       GROUP BY label`, [companyId]);
    const dailyTrend = trendRaw.map((t: any) => ({ label: (t.label ?? '').trim() || '—', delivered: parseInt(t.delivered, 10) || 0, failed: parseInt(t.failed, 10) || 0 }));
    return { rows, dailyTrend };
  }

  // ── Analytics Dashboard ──────────────────────────────────────────
  async analyticsDashboard(companyId: string) {
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const revRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM invoice_date::date)::int AS yr, EXTRACT(MONTH FROM invoice_date::date)::int AS mo, SUM(total::numeric) AS v
       FROM invoices WHERE company_id=$1 AND status NOT IN ('void','draft') GROUP BY yr, mo ORDER BY yr, mo`, [companyId]);
    const billRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM bill_date::date)::int AS yr, EXTRACT(MONTH FROM bill_date::date)::int AS mo, SUM(total::numeric) AS v
       FROM bills WHERE company_id=$1 AND status NOT IN ('void','draft') GROUP BY yr, mo ORDER BY yr, mo`, [companyId]);
    const revenueTrend = revRows.slice(-12).map((r: any) => ({ label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`, value: r2(num(r.v)) }));
    const billByKey = new Map<string, number>();
    for (const b of billRows) billByKey.set(`${b.yr}-${b.mo}`, num(b.v));
    const cashFlowTrend = revRows.slice(-12).map((r: any) => ({ label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`, value: r2(num(r.v) - (billByKey.get(`${r.yr}-${r.mo}`) ?? 0)) }));

    const expRows = await this.dataSource.query(
      `SELECT v.company_name AS label, SUM(b.total::numeric) AS value FROM bills b JOIN vendors v ON v.id=b.vendor_id
       WHERE b.company_id=$1 AND b.status NOT IN ('void','draft') GROUP BY v.company_name ORDER BY value DESC`, [companyId]);
    const expenseCategories = expRows.map((e: any) => ({ label: e.label, value: r2(num(e.value)) }));

    const custRows = await this.dataSource.query(
      `SELECT c.name AS label, SUM(i.total::numeric) AS value FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.company_id=$1 AND i.status NOT IN ('void','draft') GROUP BY c.name ORDER BY value DESC LIMIT 5`, [companyId]);
    const topCustomers = custRows.map((c: any) => ({ label: c.label, value: r2(num(c.value)) }));

    const aging = await this.arAging(companyId);
    const arAgingTrend = [{
      label: 'Current',
      current: aging.totals.current,
      bucket1to30: aging.totals.bucket1to30,
      bucket31to60: aging.totals.bucket31to60,
      bucket61to90: aging.totals.bucket61to90,
      bucket90Plus: aging.totals.bucket90Plus,
    }];

    return { revenueTrend, expenseCategories, cashFlowTrend, topCustomers, arAgingTrend };
  }

  // ── Simple delivery status breakdown (legacy endpoint) ───────────
  async deliveryReport(companyId: string, startDate: string, endDate: string) {
    const qb = this.deliveryRepo.createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid', { cid: companyId })
      .groupBy('d.status');
    return qb.getRawMany();
  }

  async aging(companyId: string, asOfDate: string, type: 'ar' | 'ap') {
    return type === 'ap' ? this.apAging(companyId) : this.arAging(companyId);
  }

  // ── Admin home dashboard summary ─────────────────────────────────
  async dashboardSummary(companyId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = now.toISOString().slice(0, 10);

    const invoiceTotal = await this.sum('invoices', 'total', companyId, 'invoice_date', monthStart, monthEnd);
    const billTotal = await this.sum('bills', 'total', companyId, 'bill_date', monthStart, monthEnd);
    const outstandingAR = (await this.dataSource.query(
      `SELECT COALESCE(SUM(balance::numeric),0) AS v FROM invoices WHERE company_id=$1 AND status NOT IN ('paid','void')`, [companyId]))[0]?.v;
    // What we owe suppliers, reconciled to account 2000.
    //
    // Two corrections to what this used to be. DRAFT bills post no journal
    // entry at all, so counting them showed money that does not exist in the
    // ledger and never cleared (apAging already excludes them — this was an
    // inconsistency, not a judgement). And an unapplied vendor credit has
    // already been debited to A/P, so the gross bill balances overstate the
    // liability until the credit is applied to a specific bill.
    const pendingAP = (await this.dataSource.query(
      `SELECT GREATEST(
                COALESCE((SELECT SUM(balance::numeric) FROM bills
                           WHERE company_id=$1 AND status NOT IN ('paid','void','draft')), 0)
              - COALESCE((SELECT SUM(balance::numeric) FROM vendor_credits
                           WHERE company_id=$1 AND status NOT IN ('void','closed')), 0),
              0) AS v`, [companyId]))[0]?.v;
    const itemCount = await this.itemRepo.count({ where: { companyId } });
    const deliveryStats = await this.deliveryRepo.createQueryBuilder('d')
      .select('d.status', 'status').addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid', { cid: companyId }).groupBy('d.status').getRawMany();
    const recentInvoices = await this.invoiceRepo.createQueryBuilder('i')
      .where('i.companyId = :cid', { cid: companyId }).orderBy('i.invoiceDate', 'DESC').limit(5).getMany();
    const recentBills = await this.billRepo.createQueryBuilder('b')
      .where('b.companyId = :cid', { cid: companyId }).orderBy('b.billDate', 'DESC').limit(5).getMany();

    const deliveryBreakdown: Record<string, number> = { pending: 0, assigned: 0, in_transit: 0, delivered: 0, failed: 0, cancelled: 0, unassigned: 0 };
    let deliveryTotal = 0;
    for (const row of deliveryStats) { deliveryBreakdown[row.status] = parseInt(row.count, 10); deliveryTotal += parseInt(row.count, 10); }

    const recentTransactions = [
      ...recentInvoices.map((inv) => ({ id: inv.id, type: 'invoice' as const, description: inv.invoiceNumber, date: inv.invoiceDate, amount: num(inv.total), status: inv.status })),
      ...recentBills.map((bill) => ({ id: bill.id, type: 'bill' as const, description: bill.billNumber, date: bill.billDate, amount: num(bill.total), status: bill.status })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 8);

    const overdueInvoicesCount = recentInvoices.filter((inv) => inv.status !== 'paid' && inv.status !== 'void' && new Date(inv.dueDate) < now).length;
    const alerts: { id: string; message: string; severity: 'red' | 'amber' | 'blue' }[] = [];
    if (overdueInvoicesCount > 0) alerts.push({ id: 'overdue', message: `${overdueInvoicesCount} overdue invoice(s) require attention.`, severity: 'red' });
    if (num(pendingAP) > 0) alerts.push({ id: 'pending_bills', message: `You have pending bills totalling Rs ${num(pendingAP).toLocaleString()}.`, severity: 'amber' });
    if (deliveryBreakdown.pending > 0) alerts.push({ id: 'pending_delivery', message: `${deliveryBreakdown.pending} delivery order(s) awaiting assignment.`, severity: 'blue' });

    const setup = await this.setupStatus(companyId, itemCount);

    return {
      totalRevenue: invoiceTotal,
      totalExpenses: billTotal,
      outstandingAR: num(outstandingAR),
      pendingAP: num(pendingAP),
      inventoryItems: itemCount,
      deliveryBreakdown,
      deliveryTotal,
      recentTransactions,
      alerts,
      setup,
      period: { startDate: monthStart, endDate: monthEnd },
    };
  }

  /**
   * Guided first-run setup signals (FinMatrixGuide §5.7). Each step's `done`
   * reflects whether the underlying data exists; `completed` is the company's
   * dismiss/finish flag. Surfaced on the dashboard so the checklist can show or
   * hide itself. Purely informational — no accounting logic here.
   */
  private async setupStatus(companyId: string, itemCount: number) {
    const count1 = async (sql: string) =>
      parseInt((await this.dataSource.query(sql, [companyId]))[0]?.v ?? '0', 10);

    const openingBalance = await count1(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM general_ledger WHERE company_id=$1 AND source_type='opening_balance')
         OR EXISTS (SELECT 1 FROM accounts WHERE company_id=$1 AND opening_balance::numeric <> 0)
       THEN 1 ELSE 0 END AS v`,
    );
    const customAccounts = await count1(
      `SELECT COUNT(*) v FROM accounts WHERE company_id=$1`,
    );
    const customers = await count1(`SELECT COUNT(*) v FROM customers WHERE company_id=$1`);
    const vendors = await count1(`SELECT COUNT(*) v FROM vendors WHERE company_id=$1`);
    const taxRates = await count1(`SELECT COUNT(*) v FROM tax_rates WHERE company_id=$1`);
    const company = await this.dataSource.query(
      `SELECT setup_completed AS "v" FROM companies WHERE id=$1`,
      [companyId],
    );

    const steps = {
      openingBalance: openingBalance > 0,
      chartOfAccounts: customAccounts > 0,
      inventory: itemCount > 0,
      customers: customers > 0,
      vendors: vendors > 0,
      taxRates: taxRates > 0,
    };
    return {
      completed: company[0]?.v === true,
      steps,
    };
  }

  // ── Trial Balance (derived; ties to Balance Sheet + P&L) ─────────
  // Debits = Cash + AR + Inventory + COGS + OpEx
  // Credits = AP + Sales Revenue + Opening Equity
  // Opening Equity is back-solved so the sheet balances and closing equity
  // (opening + net income) equals the Balance Sheet equity.
  // ── Trial Balance (ledger-derived) ───────────────────────────────
  async trialBalance(companyId: string, startDate: string, endDate: string) {
    const s = startDate || '1970-01-01';
    const e = endDate || '2999-12-31';
    const glRows = await this.glByAccount(companyId, s, e);

    // Each account's net (debits − credits) lands in its natural column. Since
    // every posted entry is balanced, Σ net across accounts is 0, so the column
    // totals are equal — the trial balance always balances to the paisa.
    const nets = glRows.map((row) => ({
      accountCode: row.accountNumber,
      accountName: row.accountName,
      net: num(row.dr) - num(row.cr),
    }));

    const rows = nets
      .map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        debit: a.net >= 0 ? r2(a.net) : 0,
        credit: a.net < 0 ? r2(-a.net) : 0,
      }))
      .filter((row) => row.debit > 0 || row.credit > 0);

    // Foot the columns from the UNROUNDED nets, then round once.
    //
    // That claim above only holds at full precision. Summing the ROUNDED
    // column values instead — which is what this did — breaks it, because
    // Σ round(x) is not round(Σ x): the ledger carries four decimals, so every
    // account can hide up to half a paisa, and across thirty-odd accounts the
    // two columns drift apart. A trial balance whose columns do not foot is
    // not a trial balance, however small the gap. The rows keep their rounded
    // figures for presentation; only the totals are computed at full precision.
    const totalDebits = r2(nets.reduce((a, x) => (x.net > 0 ? a + x.net : a), 0));
    const totalCredits = r2(nets.reduce((a, x) => (x.net < 0 ? a - x.net : a), 0));
    return {
      range: { startDate: s, endDate: e },
      rows,
      totalDebits,
      totalCredits,
      isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
    };
  }

  // ── Cash Flow Statement (period, ledger-derived direct method) ───
  // Derived from the actual posted ledger movements on the Cash/Bank accounts,
  // by the date the cash truly moved. A customer payment therefore lands on its
  // payment date (not the invoice date), a bill payment on its payment date,
  // and tax/payroll/manual cash entries are all captured automatically. This is
  // the QuickBooks "direct method" and ties exactly to the Balance Sheet cash
  // (FinMatrixGuide §5.4): ending cash == Σ(debit − credit) on cash accounts
  // through endDate.
  async cashFlow(
    companyId: string,
    startDate: string,
    endDate: string,
  ): Promise<CashFlowReport> {
    const s = startDate || '1970-01-01';
    const e = endDate || new Date().toISOString().slice(0, 10);
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Cash/Bank accounts (sub_type), so custom user-added bank accounts count too.
    const cashFilter = `a.sub_type IN ('Cash','Bank')`;

    // Beginning cash = net cash movement on cash/bank accounts before the period.
    const beginRows = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric - g.credit::numeric),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND ${cashFilter} AND g.date < $2`,
      [companyId, s],
    );
    const beginningCash = r2(num(beginRows[0]?.v));

    // In-period cash movement grouped by the source document type. This is the
    // DIRECT method: useful internally because every line traces to a document
    // type. It is NOT what QuickBooks Online publishes — QBO's built-in
    // Statement of Cash Flows is the INDIRECT one, built below.
    const srcRows = await this.dataSource.query(
      `SELECT g.source_type AS src,
              COALESCE(SUM(g.debit::numeric),0)  AS inflow,
              COALESCE(SUM(g.credit::numeric),0) AS outflow
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND ${cashFilter} AND g.date >= $2 AND g.date <= $3
        GROUP BY g.source_type`,
      [companyId, s, e],
    );

    // source_type → statement line + section. Unmapped types fall into
    // operating "Other cash movements" so the statement always ties out.
    type Section = 'operating' | 'investing' | 'financing';
    const META: Record<string, { label: string; section: Section }> = {
      payment: { label: 'Cash received from customers', section: 'operating' },
      invoice: { label: 'Cash received from customers', section: 'operating' },
      credit_memo: { label: 'Customer refunds', section: 'operating' },
      credit_memo_refund: { label: 'Customer refunds', section: 'operating' },
      bill_payment: { label: 'Cash paid to suppliers', section: 'operating' },
      bill: { label: 'Cash paid to suppliers', section: 'operating' },
      vendor_credit: { label: 'Vendor refunds received', section: 'operating' },
      payroll: { label: 'Payroll paid', section: 'operating' },
      tax_payment: { label: 'Tax payments', section: 'operating' },
      opening_balance: { label: 'Opening balance / owner funding', section: 'financing' },
      journal_entry: { label: 'Other cash movements', section: 'operating' },
    };

    const buckets: Record<Section, Map<string, number>> = {
      operating: new Map(),
      investing: new Map(),
      financing: new Map(),
    };
    for (const row of srcRows) {
      const net = num(row.inflow) - num(row.outflow);
      if (Math.abs(net) < 0.005) continue;
      const meta = META[row.src as string] ?? { label: 'Other cash movements', section: 'operating' as Section };
      const bucket = buckets[meta.section];
      bucket.set(meta.label, (bucket.get(meta.label) ?? 0) + net);
    }

    const toSection = (m: Map<string, number>) => {
      const lines = Array.from(m.entries())
        .map(([label, amount]) => ({ label, amount: r2(amount) }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      return { lines, total: r2(lines.reduce((t, l) => t + l.amount, 0)) };
    };
    const operating = toSection(buckets.operating);
    const investing = toSection(buckets.investing);
    const financing = toSection(buckets.financing);

    const netChange = r2(operating.total + investing.total + financing.total);
    const endingCash = r2(beginningCash + netChange);

    // Monthly net-cash trend within range.
    const trendRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM g.date)::int AS yr, EXTRACT(MONTH FROM g.date)::int AS mo,
              COALESCE(SUM(g.debit::numeric - g.credit::numeric),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND ${cashFilter} AND g.date >= $2 AND g.date <= $3
        GROUP BY yr, mo ORDER BY yr, mo`,
      [companyId, s, e],
    );
    const monthlyTrend = trendRows.slice(-12).map((r: any) => ({
      label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`,
      value: r2(num(r.v)),
    }));

    const operatingIndirect = await this.buildOperatingIndirect(
      companyId,
      s,
      e,
      operating.total,
    );

    return {
      range: { startDate: s, endDate: e },
      operating,
      investing,
      financing,
      netChange,
      beginningCash,
      endingCash,
      monthlyTrend,
      operatingIndirect,
    };
  }

  /**
   * Indirect operating reconciliation — the presentation QuickBooks Online
   * publishes: start at net income, add back non-cash charges, then adjust for
   * the working capital that moved without cash following it.
   *
   * The two methods are the same number by construction: direct operating is
   * total cash movement less investing and financing, and the indirect walk
   * reaches the same place from the accrual side. Rather than trust that, the
   * residual against the direct total is measured and, if anything is left,
   * carried on an explicit "Other operating adjustments" line — the statement
   * always ties AND always shows what could not be attributed.
   *
   * Reads only; nothing here posts.
   */
  private async buildOperatingIndirect(
    companyId: string,
    s: string,
    e: string,
    directOperatingTotal: number,
  ): Promise<OperatingIndirect> {
    // The opening side is the day BEFORE the period starts, so the first day's
    // activity counts as movement.
    const dayBefore = new Date(`${s}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const [openingBal, closingBal, periodRows] = await Promise.all([
      this.balancesAsOf(companyId, dayBefore.toISOString().slice(0, 10)),
      this.balancesAsOf(companyId, e),
      this.glByAccount(companyId, s, e),
    ]);

    const netIncome = this.netIncomeFrom(periodRows);

    const delta = (
      pick: (code: string, meta: { type: string; subType: string }) => boolean,
    ): number => {
      let d = 0;
      for (const [code, meta] of closingBal) {
        if (pick(code, meta))
          d += meta.balance - (openingBal.get(code)?.balance ?? 0);
      }
      return d;
    };

    const isCashLike = (m: { subType: string }) =>
      m.subType === 'Cash' || m.subType === 'Bank';
    const inRange = (code: string, lo: number, hi: number) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n >= lo && n <= hi;
    };

    // 1250 sits INSIDE 1200–1299, so Inventory excludes it explicitly —
    // counting Goods in Transit in both would double the adjustment. Same for
    // GRNI 2050, excluded from other liabilities.
    const dAR = delta(
      (_c, m) => m.type === 'asset' && m.subType === 'Accounts Receivable',
    );
    const dInventory = delta(
      (c, m) => m.type === 'asset' && inRange(c, 1200, 1299) && c !== '1250',
    );
    const dGit = delta((c) => c === '1250');
    const dOtherAssets = delta(
      (c, m) =>
        m.type === 'asset' &&
        !isCashLike(m) &&
        m.subType !== 'Accounts Receivable' &&
        !inRange(c, 1200, 1299),
    );
    const dAP = delta(
      (_c, m) => m.type === 'liability' && m.subType === 'Accounts Payable',
    );
    const dGrni = delta((c) => c === '2050');
    const dOtherLiabs = delta(
      (c, m) =>
        m.type === 'liability' &&
        m.subType !== 'Accounts Payable' &&
        c !== '2050',
    );
    const depreciation = delta(
      (_c, m) => m.type === 'expense' && m.subType === 'Depreciation',
    );

    // An asset going UP consumes cash; a liability going UP releases it.
    const candidates: CashFlowLine[] = [
      { label: 'Depreciation & amortisation', amount: depreciation },
      { label: 'Accounts Receivable', amount: -dAR },
      { label: 'Inventory', amount: -dInventory },
      { label: 'Goods in Transit', amount: -dGit },
      { label: 'Other current assets', amount: -dOtherAssets },
      { label: 'Accounts Payable', amount: dAP },
      { label: 'Goods Received Not Invoiced', amount: dGrni },
      { label: 'Other current liabilities', amount: dOtherLiabs },
    ];

    const adjustments = candidates
      .filter((l) => Math.abs(l.amount) > 0.005)
      .map((l) => ({ label: l.label, amount: r2(l.amount) }));

    const subtotal = r2(
      netIncome + adjustments.reduce((t, l) => t + l.amount, 0),
    );
    const residual = r2(directOperatingTotal - subtotal);
    if (Math.abs(residual) > 0.005) {
      adjustments.push({
        label: 'Other operating adjustments',
        amount: residual,
      });
    }

    return { netIncome, adjustments, total: r2(directOperatingTotal) };
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    const header = keys.join(',');
    const lines = rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
    return [header, ...lines].join('\n');
  }
}
