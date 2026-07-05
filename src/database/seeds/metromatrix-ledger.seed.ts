/**
 * MetroMatrix Ledger Seed (post-hardening, FinMatrixGuide-compliant)
 * =================================================================
 * Usage:  npm run seed:metromatrix:ledger   (local)
 *         node dist/database/seeds/metromatrix-ledger.seed.js  (prod)
 *
 * Unlike the legacy seed (which inserted documents directly and never touched
 * the general ledger), this one boots the real Nest application context and
 * creates ~1 year of MetroMatrix activity THROUGH THE SERVICES, so every
 * document posts a balanced double-entry journal. The ledger-derived reports
 * (Trial Balance, Balance Sheet, P&L) therefore populate correctly.
 *
 * It KEEPS the registered MetroMatrix company, its admin login, the delivery
 * riders, and the chart of accounts — it only resets transactional + master
 * data and rebuilds it. Idempotent.
 *
 * Login after running:  metromatrix@gmail.com / 123456
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { Vendor } from '../../modules/vendors/entities/vendor.entity';
import { InventoryItem } from '../../modules/inventory/entities/inventory-item.entity';
import { TaxRate } from '../../modules/tax/entities/tax-rate.entity';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Company } from '../../modules/companies/entities/company.entity';
import { User } from '../../modules/users/entities/user.entity';
import { Bill } from '../../modules/bills/entities/bill.entity';
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { Delivery } from '../../modules/deliveries/entities/delivery.entity';
import { DeliveryItem } from '../../modules/deliveries/entities/delivery-item.entity';
import { InvoicesService } from '../../modules/invoices/invoices.service';
import { PostingService } from '../../modules/journal-entries/posting.service';
import { BillsService } from '../../modules/bills/bills.service';
import { PaymentsService } from '../../modules/payments/payments.service';
import { PurchaseOrdersService } from '../../modules/purchase-orders/purchase-orders.service';
import {
  ACCT_CASH,
  ACCT_BANK,
  ACCT_OPENING_BALANCE_EQUITY,
} from '../../modules/accounts/accounts.constants';

loadEnv();

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const invoices = app.get(InvoicesService);
  const bills = app.get(BillsService);
  const payments = app.get(PaymentsService);
  const pos = app.get(PurchaseOrdersService);
  const posting = app.get(PostingService);

  console.log('> Connected. Re-seeding MetroMatrix through the ledger…\n');

  const company = await ds.getRepository(Company).findOne({
    where: { name: 'MetroMatrix' },
  });
  if (!company) {
    console.error('✗ MetroMatrix company not found. Run seed:metromatrix first.');
    await app.close();
    process.exit(1);
  }
  const cid = company.id;
  const admin = await ds.getRepository(User).findOne({
    where: { email: 'metromatrix@gmail.com' },
  });
  const uid = admin?.id ?? company.createdBy;
  console.log(`  company=${cid}  admin=${uid}`);

  // ── 1. Reset transactional + master data (keep company/users/COA) ──
  const del = (sql: string) => ds.query(sql, [cid]).catch((e) => {
    console.warn('   (skip)', e.message);
  });
  await del(`DELETE FROM payment_applications WHERE payment_id IN (SELECT id FROM payments WHERE company_id=$1)`);
  await del(`DELETE FROM payments WHERE company_id=$1`);
  await del(`DELETE FROM bill_payments WHERE company_id=$1`);
  await del(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id=$1)`);
  await del(`DELETE FROM invoices WHERE company_id=$1`);
  await del(`DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE company_id=$1)`);
  await del(`DELETE FROM bills WHERE company_id=$1`);
  await del(`DELETE FROM purchase_order_lines WHERE order_id IN (SELECT id FROM purchase_orders WHERE company_id=$1)`);
  await del(`DELETE FROM purchase_orders WHERE company_id=$1`);
  await del(`DELETE FROM journal_entry_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id=$1)`);
  await del(`DELETE FROM journal_entries WHERE company_id=$1`);
  await del(`DELETE FROM general_ledger WHERE company_id=$1`);
  await del(`DELETE FROM inventory_movements WHERE company_id=$1`);
  await del(`DELETE FROM inventory_adjustments WHERE company_id=$1`);
  await del(`DELETE FROM tax_payments WHERE company_id=$1`);
  // Delivery module: old rows reference customers/items that are recreated
  // below — leaving them produces a broken-looking demo.
  await del(`DELETE FROM inventory_approval_audit_entries WHERE company_id=$1`);
  await del(`DELETE FROM inventory_update_request_lines WHERE request_id IN (SELECT id FROM inventory_update_requests WHERE company_id=$1)`);
  await del(`DELETE FROM inventory_update_requests WHERE company_id=$1`);
  await del(`DELETE FROM shadow_inventory_snapshots WHERE company_id=$1`);
  await del(`DELETE FROM delivery_location_logs WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id=$1)`);
  await del(`DELETE FROM delivery_status_history WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id=$1)`);
  await del(`DELETE FROM delivery_issues WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id=$1)`);
  await del(`DELETE FROM delivery_signatures WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id=$1)`);
  await del(`DELETE FROM delivery_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id=$1)`);
  await del(`DELETE FROM deliveries WHERE company_id=$1`);
  await del(`UPDATE agencies SET inventory = '[]'::jsonb WHERE company_id=$1`);
  await del(`DELETE FROM customers WHERE company_id=$1`);
  await del(`DELETE FROM vendors WHERE company_id=$1`);
  await del(`DELETE FROM inventory_items WHERE company_id=$1`);
  await del(`DELETE FROM tax_rates WHERE company_id=$1`);
  // Reset all account running balances to their opening balance.
  await del(`UPDATE accounts SET balance = opening_balance WHERE company_id=$1`);
  console.log('  ✓ reset transactional + master data');

  // ── 2. Master data ──
  const custRepo = ds.getRepository(Customer);
  const customers = await custRepo.save(
    [
      { name: 'Tariq General Store', city: 'Lahore' },
      { name: 'Al-Madina Mart', city: 'Lahore' },
      { name: 'Iqbal Grocery', city: 'Faisalabad' },
      { name: 'Rehman Superstore', city: 'Rawalpindi' },
      { name: 'City Wholesale', city: 'Multan' },
    ].map((c, i) =>
      custRepo.create({
        companyId: cid, name: c.name, company: c.name,
        email: `cust${i + 1}@metromatrix.com`, phone: `+92-300-44411${i}${i}`,
        billingAddress: { city: c.city, country: 'Pakistan' },
        shippingAddress: { city: c.city, country: 'Pakistan' },
        creditLimit: '500000', paymentTerms: 'net30', balance: '0', isActive: true, notes: null,
      }),
    ),
  );

  const vendRepo = ds.getRepository(Vendor);
  const vendors = await vendRepo.save(
    [
      'Habib Oil Mills', 'Pak Detergent Industries', 'Sufi Cooking Oil',
    ].map((n, i) =>
      vendRepo.create({
        companyId: cid, companyName: n, contactPerson: `Mr. ${n.split(' ')[0]}`,
        email: `vendor${i + 1}@metromatrix.com`, phone: `+92-42-357610${i}0`,
        address: { city: 'Lahore', country: 'Pakistan' }, paymentTerms: 'net30',
        taxId: null, defaultExpenseAccountId: null, balance: '0', isActive: true, notes: null,
      }),
    ),
  );

  const itemRepo = ds.getRepository(InventoryItem);
  const items = await itemRepo.save(
    [
      { sku: 'CO-HABIB-5L', name: 'Habib Cooking Oil 5L', cat: 'Cooking Oil', cost: '1850', sell: '2400' },
      { sku: 'DET-SURF-1KG', name: 'Surf Excel 1KG', cat: 'Detergent', cost: '420', sell: '560' },
      { sku: 'CO-SUFI-5L', name: 'Sufi Cooking Oil 5L', cat: 'Cooking Oil', cost: '1780', sell: '2300' },
      { sku: 'DW-LIQ-500', name: 'Dishwash Liquid 500ml', cat: 'Cleaners', cost: '180', sell: '250' },
      { sku: 'GHEE-DALDA-1', name: 'Dalda Ghee 1KG', cat: 'Ghee', cost: '950', sell: '1250' },
      { sku: 'RICE-BAS-5', name: 'Basmati Rice 5KG', cat: 'Grocery', cost: '1400', sell: '1850' },
    ].map((p) =>
      itemRepo.create({
        companyId: cid, sku: p.sku, name: p.name, description: null, category: p.cat,
        unitOfMeasure: 'unit', costMethod: 'average', unitCost: p.cost, sellingPrice: p.sell,
        quantityOnHand: '0', quantityOnOrder: '0', quantityCommitted: '0', reorderPoint: '50',
        reorderQuantity: '200', minStock: '20', maxStock: '5000', sourceAgencyId: null,
        locationId: null, serialTracking: false, lotTracking: false, barcodeData: null, isActive: true,
      }),
    ),
  );

  const taxRepo = ds.getRepository(TaxRate);
  await taxRepo.save(
    taxRepo.create({
      companyId: cid, name: 'GST (17%)', rate: '17', type: 'sales' as any,
      authority: 'FBR', isActive: true, isDefault: true,
    }),
  );
  console.log(`  ✓ ${customers.length} customers, ${vendors.length} vendors, ${items.length} items, 1 tax rate`);

  // Resolve cash + an expense account for payments / direct bills.
  const acctRepo = ds.getRepository(Account);
  const cashAcct = await acctRepo.findOneByOrFail({ companyId: cid, accountNumber: ACCT_CASH });
  const bankAcct = await acctRepo.findOneBy({ companyId: cid, accountNumber: ACCT_BANK });
  const cashId = cashAcct.id;
  // Route both collections and payments through one cash account so the demo
  // balance sheet shows a single, positive cash figure (no overdrawn account).
  void bankAcct;
  const bankId = cashId;
  const rentAcct = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6000' });
  const utilAcct = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6100' });

  // Opening cash — posted through the engine (Dr Cash / Cr Opening Balance
  // Equity), dated before the first month of activity, exactly as an
  // accountant would enter it. Keeps the demo balance sheet cash healthy
  // while every report still derives from the ledger.
  const obeAcct = await acctRepo.findOneBy({ companyId: cid, accountNumber: ACCT_OPENING_BALANCE_EQUITY });
  if (obeAcct) {
    const openDate = ymd(new Date(new Date().getFullYear(), new Date().getMonth() - 12, 1));
    await ds.transaction(async (manager) => {
      await posting.createEntry(manager, {
        companyId: cid,
        date: openDate,
        memo: 'Opening cash balance',
        createdBy: uid,
        status: 'posted',
        sourceType: 'opening_balance',
        sourceId: cashAcct.id,
        lines: [
          { accountId: cashAcct.id, description: 'Opening cash', debit: '250000.0000', credit: '0', lineOrder: 0 },
          { accountId: obeAcct.id, description: 'Opening balance offset', debit: '0', credit: '250000.0000', lineOrder: 1 },
        ],
      });
    });
    console.log('  ✓ opening cash 250,000 posted (Dr 1000 / Cr 3900)');
  }

  // ── 3. Twelve months of activity, posted through the services ──
  const now = new Date();
  let invCount = 0, billCount = 0, payCount = 0, poCount = 0, errors = 0;

  for (let m = 11; m >= 0; m--) {
    const base = new Date(now.getFullYear(), now.getMonth() - m, 1);
    // Clamp to today: a demo document dated in the future would be excluded
    // from as-of-today reports and break the cross-report ties.
    const day = (n: number) => {
      const d = new Date(base.getFullYear(), base.getMonth(), n);
      return ymd(d > now ? now : d);
    };
    const mlabel = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;

    // Each month trades in two products. We BUY ~ what we SELL (plus a small
    // buffer) so inventory and cash stay healthy and the year is profitable.
    const A = items[m % items.length];
    const B = items[(m + 1) % items.length];

    // 3a. Purchase order → receive → bill → pay (stocks inventory via GRNI).
    try {
      const po = await pos.create(cid, {
        vendorId: vendors[m % vendors.length].id,
        orderDate: day(2),
        lines: [A, B].map((it) => ({
          itemId: it.id, description: it.name, orderedQty: '30', unitCost: it.unitCost, taxRate: '0',
        })),
      } as any);
      const poFull = await pos.getById(cid, po.id).catch(() => null);
      const lines = (poFull as any)?.lines ?? (po as any).lines ?? [];
      await pos.receive(cid, uid, po.id, {
        lines: lines.map((l: any) => ({ lineId: l.id, receivedQty: '30' })),
      } as any);
      const { billId } = await pos.createBill(cid, uid, po.id, {
        billNumber: `PB-${mlabel}`, billDate: day(5), dueDate: day(25),
      } as any);
      poCount++; billCount++;
      const bill = await ds.getRepository(Bill).findOneBy({ id: billId });
      if (bill) {
        await bills.pay(cid, uid, {
          vendorId: bill.vendorId, paymentDate: day(20), paymentMethod: 'bank_transfer',
          bankAccountId: bankId, applications: [{ billId, amount: bill.balance }],
        } as any);
        payCount++;
      }
    } catch (e: any) { errors++; console.warn(`   PO ${m} failed:`, e.message); }

    // 3b. Three sales invoices selling those two products (27 of each ≤ 30 in
    // stock), payment collected on ~90%.
    for (let k = 0; k < 3; k++) {
      try {
        const cust = customers[(m + k) % customers.length];
        const inv = await invoices.create(cid, uid, {
          customerId: cust.id, invoiceDate: day(8 + k * 5), dueDate: day(28),
          status: 'sent', discountType: 'none', discountValue: '0',
          lines: [
            { description: A.name, quantity: '9', unitPrice: A.sellingPrice, taxRate: '17', itemId: A.id },
            { description: B.name, quantity: '9', unitPrice: B.sellingPrice, taxRate: '17', itemId: B.id },
          ],
        } as any);
        invCount++;
        if ((m * 3 + k) % 10 !== 0) {
          const full = await ds.getRepository(Invoice).findOneBy({ id: inv.id });
          if (full) {
            await payments.receive(cid, uid, {
              customerId: cust.id, paymentDate: day(24), paymentMethod: 'cash',
              amount: full.total, bankAccountId: cashId,
              applications: [{ invoiceId: inv.id, amount: full.total }],
            } as any);
            payCount++;
          }
        }
      } catch (e: any) { errors++; console.warn(`   INV ${m}-${k} failed:`, e.message); }
    }

    // 3c. One modest direct expense bill (rent or utilities), paid.
    try {
      const exp = m % 2 === 0 ? rentAcct : utilAcct;
      if (exp) {
        const eb = await bills.create(cid, uid, {
          vendorId: vendors[(m + 1) % vendors.length].id,
          billNumber: `EXP-${mlabel}`, billDate: day(3), dueDate: day(18), status: 'open',
          lines: [{ accountId: exp.id, description: m % 2 === 0 ? 'Monthly rent' : 'Utilities', amount: '12000', taxRate: '0' }],
        } as any);
        billCount++;
        const ebFull = await ds.getRepository(Bill).findOneBy({ id: eb.id });
        if (ebFull) {
          await bills.pay(cid, uid, {
            vendorId: ebFull.vendorId, paymentDate: day(15), paymentMethod: 'bank_transfer',
            bankAccountId: bankId, applications: [{ billId: eb.id, amount: ebFull.balance }],
          } as any);
          payCount++;
        }
      }
    } catch (e: any) { errors++; console.warn(`   EXP ${m} failed:`, e.message); }
  }

  // ── 4. Delivery-module demo data (fresh customers/items, riders kept) ──
  // Statuses only go up to 'arrived' or stay 'delivered' WITHOUT an approval
  // request: stock/ledger effects happen exclusively through the real
  // approval flow, so nothing here can un-tie the books. Presenting live:
  // advance a delivery as a rider, submit the bill photo, approve it — the
  // COGS/Inventory posting happens for real.
  try {
    const riders: Array<{ id: string }> = await ds.query(
      `SELECT p.user_id AS id FROM delivery_personnel_profiles p WHERE p.company_id=$1 AND p.status='active' ORDER BY p.created_at`,
      [cid],
    );
    if (riders.length > 0) {
      const dRepo = ds.getRepository(Delivery);
      const diRepo = ds.getRepository(DeliveryItem);
      const zones = ['Gulberg', 'DHA', 'Johar Town', 'Model Town', 'Cantt'];
      const plan: Array<{ status: string; daysAgo: number }> = [
        { status: 'delivered', daysAgo: 6 },
        { status: 'delivered', daysAgo: 4 },
        { status: 'delivered', daysAgo: 2 },
        { status: 'arrived', daysAgo: 0 },
        { status: 'in_transit', daysAgo: 0 },
        { status: 'pending', daysAgo: 0 },
        { status: 'unassigned', daysAgo: 0 },
      ];
      let dCount = 0;
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        const cust = customers[i % customers.length];
        const rider = p.status === 'unassigned' ? null : riders[i % riders.length].id;
        const when = new Date(Date.now() - p.daysAgo * 86400000);
        const itA = items[i % items.length];
        const itB = items[(i + 2) % items.length];
        const d: Delivery = await dRepo.save(
          dRepo.create({
            companyId: cid,
            customerId: cust.id,
            customerName: cust.name,
            zone: zones[i % zones.length],
            address: `${cust.name}, ${(cust.billingAddress as any)?.city ?? 'Lahore'}, Pakistan`,
            referenceNo: `DEL-${ymd(when).replace(/-/g, '')}-${String(i + 1).padStart(3, '0')}`,
            personnelId: rider,
            status: p.status as never,
            priority: (i % 3 === 0 ? 'high' : 'normal') as never,
            preferredDate: ymd(when),
            notes: null,
            createdBy: uid,
            assignedAt: rider ? when : null,
            completedAt: p.status === 'delivered' ? when : null,
          } as unknown as Delivery),
        );
        await diRepo.save([
          diRepo.create({
            deliveryId: d.id, itemId: itA.id, itemName: itA.name,
            quantity: '4', orderedQty: '4', unitPrice: itA.sellingPrice,
            deliveredQty: p.status === 'delivered' ? '4' : '0', returnedQty: '0',
          } as unknown as DeliveryItem),
          diRepo.create({
            deliveryId: d.id, itemId: itB.id, itemName: itB.name,
            quantity: '2', orderedQty: '2', unitPrice: itB.sellingPrice,
            deliveredQty: p.status === 'delivered' ? '2' : '0', returnedQty: '0',
          } as unknown as DeliveryItem),
        ]);
        dCount++;
      }
      // Rider dashboards should reflect the seeded history.
      await ds.query(
        `UPDATE delivery_personnel_profiles p SET
           total_deliveries = (SELECT COUNT(*) FROM deliveries d WHERE d.personnel_id = p.user_id AND d.company_id=$1 AND d.status='delivered'),
           current_load = (SELECT COUNT(*) FROM deliveries d WHERE d.personnel_id = p.user_id AND d.company_id=$1 AND d.status IN ('pending','picked_up','in_transit','arrived')),
           is_available = true
         WHERE p.company_id=$1`,
        [cid],
      );
      console.log(`  ✓ ${dCount} deliveries across ${riders.length} riders (approval loop left LIVE for the demo)`);
    } else {
      console.warn('  (no active riders found — delivery demo data skipped)');
    }
  } catch (e: any) {
    console.warn('  delivery demo data failed:', e.message);
  }

  // Mark setup complete so the checklist hides for the demo company.
  await ds.query(`UPDATE companies SET setup_completed = true WHERE id=$1`, [cid]);

  console.log(`\n  ✓ Seeded: ${invCount} invoices, ${poCount} POs, ${billCount} bills, ${payCount} payments (${errors} errors)`);
  console.log('> Done. Reports now derive from a full year of posted ledger activity.');
  await app.close();
  process.exit(0);
}

run().catch((e) => {
  console.error('SEED FAILED:', e);
  process.exit(1);
});
