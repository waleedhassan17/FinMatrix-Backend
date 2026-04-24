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
      .addSelect('SUM(i.balanceDue::numeric)', 'balance')
      .addSelect('i.invoiceDate', 'invoiceDate')
      .where('i.companyId = :cid AND i.status != :paid', { cid: companyId, paid: 'paid' })
      .groupBy('i.customerId, i.invoiceDate')
      .orderBy('i.invoiceDate', 'ASC');
    return qb.getRawMany();
  }

  async apAging(companyId: string) {
    const qb = this.billRepo.createQueryBuilder('b')
      .select('b.vendorId', 'vendorId')
      .addSelect('SUM(b.balanceDue::numeric)', 'balance')
      .addSelect('b.billDate', 'billDate')
      .where('b.companyId = :cid AND b.status != :paid', { cid: companyId, paid: 'paid' })
      .groupBy('b.vendorId, b.billDate')
      .orderBy('b.billDate', 'ASC');
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

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    const header = keys.join(',');
    const lines = rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
    return [header, ...lines].join('\n');
  }
}
