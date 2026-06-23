import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { TaxPayment } from '../tax/entities/tax-payment.entity';

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
       LEFT JOIN general_ledger_entries g
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

  // ── Profit & Loss (ledger-derived) ───────────────────────────────
  async profitLoss(companyId: string, startDate: string, endDate: string) {
    const s = startDate || '1970-01-01';
    const e = endDate || '2999-12-31';
    const rows = await this.glByAccount(companyId, s, e);

    let revenue = 0;
    let cogs = 0;
    let expenses = 0;
    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') {
        const amt = dr - cr;
        if (this.isCogs(row)) cogs += amt;
        else expenses += amt;
      }
    }
    const grossProfit = r2(revenue - cogs);
    const netIncome = r2(grossProfit - expenses);
    return {
      range: { startDate: s, endDate: e },
      comparisonRange: null,
      revenue: r2(revenue),
      cogs: r2(cogs),
      grossProfit,
      expenses: r2(expenses),
      netIncome,
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
        if (Math.abs(amt) > 0.0001) assets.push(line(amt));
      } else if (row.type === 'liability') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) liabilities.push(line(amt));
      } else if (row.type === 'equity') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) equity.push(line(amt));
      } else if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') expense += dr - cr;
    }

    // Current-period earnings (revenue − expense) roll into equity so the sheet
    // balances (FinMatrixGuide §5.3); shown as a Retained Earnings line.
    const netIncome = r2(revenue - expense);
    if (Math.abs(netIncome) > 0.0001) {
      equity.push({
        accountCode: '3100',
        accountName: 'Net Income (current period)',
        amount: netIncome,
      });
    }

    const totalAssets = r2(assets.reduce((a, x) => a + x.amount, 0));
    const totalLiabilities = r2(liabilities.reduce((a, x) => a + x.amount, 0));
    const totalEquity = r2(equity.reduce((a, x) => a + x.amount, 0));
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
    const pendingAP = (await this.dataSource.query(
      `SELECT COALESCE(SUM(balance::numeric),0) AS v FROM bills WHERE company_id=$1 AND status NOT IN ('paid','void')`, [companyId]))[0]?.v;
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
      period: { startDate: monthStart, endDate: monthEnd },
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
    const rows = glRows
      .map((row) => {
        const net = num(row.dr) - num(row.cr);
        return {
          accountCode: row.accountNumber,
          accountName: row.accountName,
          debit: net >= 0 ? r2(net) : 0,
          credit: net < 0 ? r2(-net) : 0,
        };
      })
      .filter((row) => row.debit > 0 || row.credit > 0);

    const totalDebits = r2(rows.reduce((a, x) => a + x.debit, 0));
    const totalCredits = r2(rows.reduce((a, x) => a + x.credit, 0));
    return {
      range: { startDate: s, endDate: e },
      rows,
      totalDebits,
      totalCredits,
      isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
    };
  }

  // ── Cash Flow Statement (period) ─────────────────────────────────
  // Derived from invoice/bill cash collected & paid (same source as the
  // Balance Sheet cash), so ending cash ties to the Balance Sheet.
  async cashFlow(companyId: string, startDate: string, endDate: string) {
    const s = startDate || '1970-01-01';
    const e = endDate || new Date().toISOString().slice(0, 10);
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Cash collected on invoices / paid on bills, by the document date.
    const sumPaid = async (table: 'invoices' | 'bills', dateCol: string, from: string, to: string) =>
      num((await this.dataSource.query(
        `SELECT COALESCE(SUM(amount_paid::numeric),0) v FROM ${table}
         WHERE company_id=$1 AND status NOT IN ('void','draft') AND ${dateCol} BETWEEN $2 AND $3`,
        [companyId, from, to]))[0]?.v);

    const receipts = await sumPaid('invoices', 'invoice_date', s, e);
    const supplierPaid = await sumPaid('bills', 'bill_date', s, e);

    const operating = {
      lines: [
        { label: 'Cash received from customers', amount: r2(receipts) },
        { label: 'Cash paid to suppliers', amount: r2(-supplierPaid) },
      ],
      total: r2(receipts - supplierPaid),
    };
    const investing = { lines: [] as { label: string; amount: number }[], total: 0 };
    const financing = { lines: [] as { label: string; amount: number }[], total: 0 };
    const netChange = r2(operating.total + investing.total + financing.total);

    // Cash on hand before the period start = beginning balance.
    const dayBefore = new Date(new Date(s).getTime() - 86400000).toISOString().slice(0, 10);
    const recBefore = await sumPaid('invoices', 'invoice_date', '1970-01-01', dayBefore);
    const supBefore = await sumPaid('bills', 'bill_date', '1970-01-01', dayBefore);
    const beginningCash = r2(recBefore - supBefore);
    const endingCash = r2(beginningCash + netChange);

    // Monthly operating-cash trend within range.
    const recM = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM invoice_date::date)::int yr, EXTRACT(MONTH FROM invoice_date::date)::int mo, SUM(amount_paid::numeric) v
       FROM invoices WHERE company_id=$1 AND status NOT IN ('void','draft') AND invoice_date BETWEEN $2 AND $3 GROUP BY yr,mo`, [companyId, s, e]);
    const payM = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM bill_date::date)::int yr, EXTRACT(MONTH FROM bill_date::date)::int mo, SUM(amount_paid::numeric) v
       FROM bills WHERE company_id=$1 AND status NOT IN ('void','draft') AND bill_date BETWEEN $2 AND $3 GROUP BY yr,mo`, [companyId, s, e]);
    const inMap = new Map<string, number>();
    for (const row of recM) inMap.set(`${row.yr}-${row.mo}`, num(row.v));
    const outMap = new Map<string, number>();
    for (const row of payM) outMap.set(`${row.yr}-${row.mo}`, num(row.v));
    const keys = Array.from(new Set([...inMap.keys(), ...outMap.keys()])).sort((a, b) => {
      const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
      return ay - by || am - bm;
    });
    const monthlyTrend = keys.slice(-12).map((k) => {
      const [yr, mo] = k.split('-').map(Number);
      return { label: `${MONTH_LABELS[mo - 1]} ${String(yr).slice(2)}`, value: r2((inMap.get(k) ?? 0) - (outMap.get(k) ?? 0)) };
    });

    return {
      range: { startDate: s, endDate: e },
      operating,
      investing,
      financing,
      netChange,
      beginningCash,
      endingCash,
      monthlyTrend,
    };
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    const header = keys.join(',');
    const lines = rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
    return [header, ...lines].join('\n');
  }
}
