import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Customer } from '../customers/entities/customer.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { computeFeatures } from '../../common/features/feature-map';

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
    @InjectRepository(Vendor) private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(Invoice) private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(InventoryItem) private readonly itemRepo: Repository<InventoryItem>,
    private readonly dataSource: DataSource,
  ) {}

  async search(companyId: string, q: string, entities?: string) {
    let targetEntities = entities ? entities.split(',') : ['customers', 'vendors', 'invoices', 'bills', 'inventory'];

    // Tier enforcement (feature-map): companies without the inventory feature
    // (small business / large org) never get inventory hits back, even when
    // the caller asks for them — same lookup as FeatureGuard.
    if (targetEntities.includes('inventory')) {
      const rows: Array<{
        company_type: string | null;
        inventory_enabled: boolean | null;
        all_features_unlocked: boolean | null;
      }> = await this.dataSource.query(
        `SELECT company_type, inventory_enabled, all_features_unlocked FROM companies WHERE id = $1 LIMIT 1`,
        [companyId],
      );
      const row = rows[0];
      const features = computeFeatures({
        companyType: row?.company_type ?? null,
        inventoryEnabled: row?.inventory_enabled ?? false,
        allFeaturesUnlocked: row?.all_features_unlocked ?? false,
      });
      if (!features.inventory) {
        targetEntities = targetEntities.filter(e => e !== 'inventory');
      }
    }
    const term = `%${q}%`;
    const results: Record<string, any[]> = {};

    if (targetEntities.includes('customers')) {
      results.customers = await this.customerRepo.createQueryBuilder('c')
        .where('c.companyId = :cid AND (c.name ILIKE :q OR c.email ILIKE :q)', { cid: companyId, q: term })
        .take(20).getMany();
    }
    if (targetEntities.includes('vendors')) {
      results.vendors = await this.vendorRepo.createQueryBuilder('v')
        .where('v.companyId = :cid AND (v.companyName ILIKE :q OR v.contactPerson ILIKE :q)', { cid: companyId, q: term })
        .take(20).getMany();
    }
    if (targetEntities.includes('invoices')) {
      results.invoices = await this.invoiceRepo.createQueryBuilder('i')
        .where('i.companyId = :cid AND (i.invoiceNumber ILIKE :q OR i.notes ILIKE :q)', { cid: companyId, q: term })
        .take(20).getMany();
    }
    if (targetEntities.includes('bills')) {
      results.bills = await this.billRepo.createQueryBuilder('b')
        .where('b.companyId = :cid AND (b.billNumber ILIKE :q OR b.memo ILIKE :q)', { cid: companyId, q: term })
        .take(20).getMany();
    }
    if (targetEntities.includes('inventory')) {
      results.inventory = await this.itemRepo.createQueryBuilder('i')
        .where('i.companyId = :cid AND (i.name ILIKE :q OR i.sku ILIKE :q)', { cid: companyId, q: term })
        .take(20).getMany();
    }

    return { query: q, results };
  }
}
