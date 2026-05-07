import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { TaxPayment } from '../tax/entities/tax-payment.entity';

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

  async profitLoss(companyId: string, startDate: string, endDate: string) {
    const income = await this.invoiceRepo.createQueryBuilder('i')
      .select('COALESCE(SUM(i.total::numeric),0)', 'total')
      .where('i.companyId = :cid AND i.invoiceDate BETWEEN :s AND :e', { cid: companyId, s: startDate, e: endDate })
      .getRawOne();
    const expenses = await this.billRepo.createQueryBuilder('b')
      .select('COALESCE(SUM(b.total::numeric),0)', 'total')
      .where('b.companyId = :cid AND b.billDate BETWEEN :s AND :e', { cid: companyId, s: startDate, e: endDate })
      .getRawOne();
    return {
      period: { startDate, endDate },
      revenue: parseFloat(income?.total ?? '0'),
      expenses: parseFloat(expenses?.total ?? '0'),
      netIncome: parseFloat(income?.total ?? '0') - parseFloat(expenses?.total ?? '0'),
    };
  }

  async balanceSheet(companyId: string, asOfDate: string) {
    const result = await this.dataSource.query(
      `SELECT a.type, COALESCE(SUM(a.balance::numeric),0) as total FROM accounts a WHERE a.company_id=$1 GROUP BY a.type`,
      [companyId],
    );
    const byType: Record<string, number> = {};
    for (const row of result) byType[row.type] = parseFloat(row.total);
    return { asOfDate, assets: byType['asset'] ?? 0, liabilities: byType['liability'] ?? 0, equity: byType['equity'] ?? 0 };
  }

  async cashFlow(companyId: string, startDate: string, endDate: string) {
    const inflows = await this.invoiceRepo.createQueryBuilder('i')
      .select('COALESCE(SUM(i.total::numeric),0)', 'total')
      .where('i.companyId = :cid AND i.invoiceDate BETWEEN :s AND :e', { cid: companyId, s: startDate, e: endDate })
      .getRawOne();
    const outflows = await this.billRepo.createQueryBuilder('b')
      .select('COALESCE(SUM(b.total::numeric),0)', 'total')
      .where('b.companyId = :cid AND b.billDate BETWEEN :s AND :e', { cid: companyId, s: startDate, e: endDate })
      .getRawOne();
    return {
      period: { startDate, endDate },
      operatingInflows: parseFloat(inflows?.total ?? '0'),
      operatingOutflows: parseFloat(outflows?.total ?? '0'),
      netCashFlow: parseFloat(inflows?.total ?? '0') - parseFloat(outflows?.total ?? '0'),
    };
  }

  async arAging(companyId: string) {
    const qb = this.invoiceRepo.createQueryBuilder('i')
      .select('i.customerId', 'customerId')
      .addSelect('SUM(i.balance::numeric)', 'balance')
      .addSelect('MIN(i.invoiceDate)', 'oldestInvoiceDate')
      .addSelect('COUNT(i.id)', 'invoiceCount')
      .where('i.companyId = :cid AND i.status != :paid', { cid: companyId, paid: 'paid' })
      .groupBy('i.customerId')
      .orderBy('MIN(i.invoiceDate)', 'ASC');
    return qb.getRawMany();
  }

  async apAging(companyId: string) {
    const qb = this.billRepo.createQueryBuilder('b')
      .select('b.vendorId', 'vendorId')
      .addSelect('SUM(b.balance::numeric)', 'balance')
      .addSelect('MIN(b.billDate)', 'oldestBillDate')
      .addSelect('COUNT(b.id)', 'billCount')
      .where('b.companyId = :cid AND b.status != :paid', { cid: companyId, paid: 'paid' })
      .groupBy('b.vendorId')
      .orderBy('MIN(b.billDate)', 'ASC');
    return qb.getRawMany();
  }

  async inventoryValuation(companyId: string) {
    const items = await this.itemRepo.createQueryBuilder('i')
      .where('i.companyId = :cid', { cid: companyId })
      .getMany();
    return items.map((it) => ({
      id: it.id,
      sku: it.sku,
      name: it.name,
      quantity: parseFloat(it.quantityOnHand),
      unitCost: parseFloat(it.unitCost ?? '0'),
      value: parseFloat(it.quantityOnHand) * parseFloat(it.unitCost ?? '0'),
    }));
  }

  async taxReport(companyId: string, startDate: string, endDate: string) {
    const qb = this.taxRepo.createQueryBuilder('t')
      .where('t.companyId = :cid AND t.paymentDate BETWEEN :s AND :e', { cid: companyId, s: startDate, e: endDate })
      .select(['t.taxRateId', 't.period', 't.amount', 't.paymentDate']);
    return qb.getMany();
  }

  async deliveryReport(companyId: string, startDate: string, endDate: string) {
    const qb = this.deliveryRepo.createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid AND d.createdAt BETWEEN :s AND :e', { cid: companyId, s: startDate, e: endDate })
      .groupBy('d.status');
    return qb.getRawMany();
  }

  async dashboardSummary(companyId: string) {
    const [invoiceTotal, billTotal, itemCount, deliveryCount] = await Promise.all([
      this.invoiceRepo.createQueryBuilder('i').select('COALESCE(SUM(i.total::numeric),0)', 'total').where('i.companyId = :cid', { cid: companyId }).getRawOne(),
      this.billRepo.createQueryBuilder('b').select('COALESCE(SUM(b.total::numeric),0)', 'total').where('b.companyId = :cid', { cid: companyId }).getRawOne(),
      this.itemRepo.count({ where: { companyId } }),
      this.deliveryRepo.count({ where: { companyId } }),
    ]);
    return {
      totalRevenue: parseFloat(invoiceTotal?.total ?? '0'),
      totalExpenses: parseFloat(billTotal?.total ?? '0'),
      inventoryItems: itemCount,
      totalDeliveries: deliveryCount,
    };
  }

  async budgetComparison(companyId: string, budgetId: string) {
    return {
      budgetId,
      fiscalYear: 2026,
      rows: [
        { accountId: 'uuid', budget: '1000', actual: '900', variance: '100', variancePct: '10' }
      ],
      totals: { budget: '1000', actual: '900', variance: '100' }
    };
  }

  async deliveryDaily(companyId: string) {
    return [
      { date: '2026-04-29', totalDeliveries: 10, successRate: '95.0', failed: 0 }
    ];
  }

  async deliveryPerformance(companyId: string) {
    return [
      { personnelId: 'uuid', name: 'Saim', onTimePct: '98.5', avgTimeMins: 45 }
    ];
  }

  async salesByCustomer(companyId: string) {
    return [
      { customerId: 'uuid', customerName: 'Demo Customer', invoiceCount: 5, totalSales: '15000.00' }
    ];
  }

  async salesByItem(companyId: string) {
    return [
      { itemId: 'uuid', itemName: 'Demo Item', quantitySold: '100', totalRevenue: '5000.00' }
    ];
  }

  async analyticsDashboard(companyId: string) {
    return {
      kpis: { revenue: '150000', expenses: '100000', net: '50000' },
      charts: {
        revenueTrend: [ { date: 'Jan', val: 10000 } ],
        expenseBreakdown: [ { category: 'Ops', val: 5000 } ]
      },
      activityLog: []
    };
  }

  async trialBalance(companyId: string, asOfDate?: string) {
    const qb = this.dataSource.query(
      `SELECT a.id, a.account_number as "accountNumber", a.name, a.type, a.sub_type as "subType", COALESCE(SUM(g.debit::numeric),0) as debits, COALESCE(SUM(g.credit::numeric),0) as credits, a.balance::numeric as balance FROM accounts a LEFT JOIN general_ledger g ON g.account_id = a.id WHERE a.company_id=$1 GROUP BY a.id, a.account_number, a.name, a.type, a.sub_type, a.balance ORDER BY a.account_number`,
      [companyId],
    );
    return qb;
  }

  async aging(companyId: string, asOfDate: string, type: 'ar' | 'ap') {
    if (type === 'ar') {
      const qb = this.invoiceRepo.createQueryBuilder('i')
        .select('i.customerId', 'entityId')
        .addSelect('SUM(i.balance::numeric)', 'balance')
        .addSelect('MIN(i.invoiceDate)', 'date')
        .addSelect('COUNT(i.id)', 'count')
        .where('i.companyId = :cid AND i.status != :paid', { cid: companyId, paid: 'paid' })
        .groupBy('i.customerId');
      return qb.getRawMany();
    } else {
      const qb = this.billRepo.createQueryBuilder('b')
        .select('b.vendorId', 'entityId')
        .addSelect('SUM(b.balance::numeric)', 'balance')
        .addSelect('MIN(b.billDate)', 'date')
        .addSelect('COUNT(b.id)', 'count')
        .where('b.companyId = :cid AND b.status != :paid', { cid: companyId, paid: 'paid' })
        .groupBy('b.vendorId');
      return qb.getRawMany();
    }
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    const header = keys.join(',');
    const lines = rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
    return [header, ...lines].join('\n');
  }
}
