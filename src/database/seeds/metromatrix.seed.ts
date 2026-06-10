/**
 * MetroMatrix Demo Seed (First Update / v1.0 scope)
 * ==================================================
 * Usage:  npm run seed:metromatrix
 *
 * Builds a complete, demo-ready dataset for MetroMatrix — a Pakistani FMCG
 * distribution business — using ONLY First-Update entities. Produces ~2 years
 * of invoices & bills so every report (P&L, Balance Sheet, A/R + A/P Aging,
 * Inventory Valuation, Delivery reports) and the dashboard show rich data.
 *
 * Login credentials after running:
 *   Company Admin:  metromatrix@gmail.com   / 123456
 *   Delivery #1:    saim@metromatrix.com    / 123456
 *   Delivery #2:    haseeb@metromatrix.com  / 123456
 *
 * (Super-admin is seeded separately by `npm run seed:superadmin`.)
 *
 * This seed also removes any OTHER companies so the super-admin console shows
 * MetroMatrix only.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { User } from '../../modules/users/entities/user.entity';
import { Company } from '../../modules/companies/entities/company.entity';
import { UserCompany } from '../../modules/companies/entities/user-company.entity';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { Vendor } from '../../modules/vendors/entities/vendor.entity';
import { InventoryItem } from '../../modules/inventory/entities/inventory-item.entity';
import { Delivery } from '../../modules/deliveries/entities/delivery.entity';
import { DeliveryItem } from '../../modules/deliveries/entities/delivery-item.entity';
import { DeliveryPersonnelProfile } from '../../modules/delivery-personnel/entities/delivery-personnel-profile.entity';
import { ShadowInventorySnapshot } from '../../modules/shadow-inventory/entities/shadow-inventory-snapshot.entity';
import { Agency } from '../../modules/agencies/entities/agency.entity';
import { InventoryUpdateRequest } from '../../modules/inventory-approvals/entities/inventory-update-request.entity';
import { InventoryUpdateRequestLine } from '../../modules/inventory-approvals/entities/inventory-update-request-line.entity';
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { InvoiceLineItem } from '../../modules/invoices/entities/invoice-line-item.entity';
import { Bill } from '../../modules/bills/entities/bill.entity';
import { BillLineItem } from '../../modules/bills/entities/bill-line-item.entity';
import { PurchaseOrder } from '../../modules/purchase-orders/entities/purchase-order.entity';
import { PurchaseOrderLine } from '../../modules/purchase-orders/entities/purchase-order-line.entity';
import { TaxRate } from '../../modules/tax/entities/tax-rate.entity';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../modules/accounts/accounts.constants';
import { generateInviteCode } from '../../common/utils/reference-generator.util';

loadEnv();

function parseDatabaseUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

const ADMIN_EMAIL = 'metromatrix@gmail.com';
const ADMIN_PASSWORD = '123456';
const DP_PASSWORD = '123456';

// ── date helpers ──
const ymd = (d: Date) => d.toISOString().split('T')[0];
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const t17 = (sub: number) => +(sub * 0.17).toFixed(2);
const lt17 = (sub: number) => +(sub * 1.17).toFixed(2);

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  const parsed = dbUrl ? parseDatabaseUrl(dbUrl) : null;

  const isProd = process.env.NODE_ENV === 'production';
  const useSsl = isProd || !!dbUrl;

  const ds = new DataSource({
    type: 'postgres',
    host: parsed?.host ?? process.env.DB_HOST ?? 'localhost',
    port: parsed?.port ?? parseInt(process.env.DB_PORT ?? '5432', 10),
    username: parsed?.username ?? process.env.DB_USERNAME ?? 'finmatrix_user',
    password: parsed?.password ?? process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
    database: parsed?.database ?? process.env.DB_NAME ?? 'finmatrix',
    entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
    synchronize: true,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });
  await ds.initialize();
  console.log('> Connected. Seeding MetroMatrix demo data…\n');

  await ds
    .query(`ALTER TABLE shadow_inventory_snapshots ADD COLUMN IF NOT EXISTS item_name varchar(200)`)
    .catch(() => {});

  // ── Helper: wipe a company's transactional data (defensive, v1 tables) ──
  const wipeCompanyData = async (cid: string) => {
    const del = async (sql: string) => ds.query(sql, [cid]).catch(() => {});
    await del(`DELETE FROM inventory_update_request_lines WHERE request_id IN (SELECT id FROM inventory_update_requests WHERE company_id = $1)`);
    await del(`DELETE FROM inventory_update_requests WHERE company_id = $1`);
    await del(`DELETE FROM delivery_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id = $1)`);
    await del(`DELETE FROM deliveries WHERE company_id = $1`);
    await del(`DELETE FROM shadow_inventory_snapshots WHERE company_id = $1`);
    await del(`DELETE FROM payment_applications WHERE payment_id IN (SELECT id FROM payments WHERE company_id = $1)`);
    await del(`DELETE FROM payments WHERE company_id = $1`);
    await del(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)`);
    await del(`DELETE FROM invoices WHERE company_id = $1`);
    await del(`DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE company_id = $1)`);
    await del(`DELETE FROM bills WHERE company_id = $1`);
    await del(`DELETE FROM purchase_order_lines WHERE order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`);
    await del(`DELETE FROM purchase_orders WHERE company_id = $1`);
    await del(`DELETE FROM journal_entry_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`);
    await del(`DELETE FROM journal_entries WHERE company_id = $1`);
    await del(`DELETE FROM general_ledger_entries WHERE company_id = $1`);
    await del(`DELETE FROM tax_payments WHERE company_id = $1`);
    await del(`DELETE FROM tax_rates WHERE company_id = $1`);
  };

  // ── Remove OTHER companies so super-admin shows MetroMatrix only ──
  const others = await ds.query(`SELECT id FROM companies WHERE name <> 'MetroMatrix'`).catch(() => []);
  for (const o of others) {
    await wipeCompanyData(o.id);
    await ds.query(`DELETE FROM inventory_movements WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM inventory_items WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM agencies WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM customers WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM vendors WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM accounts WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM delivery_personnel_profiles WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM user_companies WHERE company_id = $1`, [o.id]).catch(() => {});
    await ds.query(`DELETE FROM companies WHERE id = $1`, [o.id]).catch(() => {});
  }
  if (others.length > 0) console.log(`  ✓ Removed ${others.length} other company(ies) — MetroMatrix is now the only company`);

  // ── Clean MetroMatrix's own transactional data for a fresh seed ──
  const companyRow = await ds.query(`SELECT id FROM companies WHERE name = 'MetroMatrix' LIMIT 1`);
  if (companyRow.length > 0) {
    await wipeCompanyData(companyRow[0].id);
    console.log('  ✓ Cleaned MetroMatrix transactional data for fresh seed');
  }

  await ds.transaction(async (m) => {
    // ===== 1. USERS =====
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const dpHash = await bcrypt.hash(DP_PASSWORD, 12);

    let admin = await m.findOneBy(User, { email: ADMIN_EMAIL });
    if (!admin) {
      admin = await m.save(m.create(User, {
        email: ADMIN_EMAIL, passwordHash: adminHash, displayName: 'MetroMatrix Admin',
        phone: '+92-300-1234567', role: 'admin', isActive: true,
        isEmailVerified: true, emailVerifiedAt: new Date(), defaultCompanyId: null,
      }));
      console.log(`  ✓ Admin user created: ${ADMIN_EMAIL}`);
    } else {
      admin.passwordHash = adminHash; admin.isActive = true; admin.role = 'admin';
      (admin as any).isEmailVerified = true;
      await m.save(admin);
      console.log(`  ✓ Admin user updated: ${ADMIN_EMAIL}`);
    }

    const upsertDP = async (email: string, name: string, phone: string) => {
      let u = await m.findOneBy(User, { email });
      if (!u) {
        u = await m.save(m.create(User, {
          email, passwordHash: dpHash, displayName: name, phone,
          role: 'delivery', isActive: true, isEmailVerified: true,
          emailVerifiedAt: new Date(), defaultCompanyId: null,
        }));
        console.log(`  ✓ Delivery user created: ${email}`);
      } else {
        u.passwordHash = dpHash; u.isActive = true; (u as any).role = 'delivery';
        await m.save(u);
        console.log(`  ✓ Delivery user updated: ${email}`);
      }
      return u;
    };
    const saim = await upsertDP('saim@metromatrix.com', 'Saim Raza', '+92-321-5550101');
    const haseeb = await upsertDP('haseeb@metromatrix.com', 'Haseeb Ahmed', '+92-321-5550202');

    // ===== 2. COMPANY =====
    let company = await m.findOne(Company, { where: { name: 'MetroMatrix' } });
    if (!company) {
      company = await m.save(m.create(Company, {
        name: 'MetroMatrix', industry: 'FMCG Distribution',
        address: { street: '45-B, Industrial Area, Sundar Road', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
        phone: '+92-42-35761234', email: 'info@metromatrix.com', taxId: 'NTN-7842391',
        inviteCode: generateInviteCode(6), logo: null, createdBy: admin.id, status: 'active',
      }));
      console.log(`  ✓ Company "MetroMatrix" created (invite: ${company.inviteCode})`);
    } else if (company.status !== 'active') {
      company.status = 'active';
      await m.save(company);
    }

    // ===== 3. MEMBERSHIPS =====
    const memberships: Array<{ user: User; role: 'admin' | 'delivery' }> = [
      { user: admin, role: 'admin' },
      { user: saim, role: 'delivery' },
      { user: haseeb, role: 'delivery' },
    ];
    for (const mem of memberships) {
      const existing = await m.findOne(UserCompany, { where: { userId: mem.user.id, companyId: company.id } });
      if (!existing) {
        await m.save(m.create(UserCompany, { userId: mem.user.id, companyId: company.id, role: mem.role }));
      }
    }
    for (const u of [admin, saim, haseeb]) {
      if (!u.defaultCompanyId) { u.defaultCompanyId = company.id; await m.save(u); }
    }
    console.log('  ✓ Memberships linked');

    // ===== 4. CHART OF ACCOUNTS =====
    if ((await m.countBy(Account, { companyId: company.id })) === 0) {
      await m.save(DEFAULT_CHART_OF_ACCOUNTS.map((a) => m.create(Account, {
        companyId: company!.id, accountNumber: a.accountNumber, name: a.name,
        type: a.type, subType: a.subType, parentId: null, description: null,
        openingBalance: '0', balance: '0', isActive: true,
      })));
      console.log('  ✓ Chart of accounts seeded');
    }

    // ===== 5. CUSTOMERS =====
    if ((await m.countBy(Customer, { companyId: company.id })) === 0) {
      const customers = [
        { name: 'Tariq General Store', city: 'Lahore', phone: '+92-300-4441111', email: 'tariq.store@gmail.com' },
        { name: 'Al-Madina Mart', city: 'Lahore', phone: '+92-301-4442222', email: 'almadina.mart@gmail.com' },
        { name: 'Iqbal Grocery', city: 'Faisalabad', phone: '+92-302-4443333', email: 'iqbal.grocery@gmail.com' },
        { name: 'Rehman Superstore', city: 'Rawalpindi', phone: '+92-303-4444444', email: 'rehman.super@gmail.com' },
        { name: 'City Wholesale', city: 'Multan', phone: '+92-304-4445555', email: 'city.wholesale@gmail.com' },
        { name: 'Bismillah Trading', city: 'Gujranwala', phone: '+92-305-4446666', email: 'bismillah.tr@gmail.com' },
        { name: 'Noor Enterprises', city: 'Sialkot', phone: '+92-306-4447777', email: 'noor.ent@gmail.com' },
        { name: 'Punjab Mart', city: 'Lahore', phone: '+92-307-4448888', email: 'punjab.mart@gmail.com' },
      ];
      await m.save(customers.map((c) => m.create(Customer, {
        companyId: company!.id, name: c.name, company: c.name, email: c.email, phone: c.phone,
        billingAddress: { city: c.city, country: 'Pakistan' }, shippingAddress: { city: c.city, country: 'Pakistan' },
        creditLimit: '100000', paymentTerms: 'net30', balance: '0', isActive: true, notes: null,
      })));
      console.log('  ✓ 8 customers created');
    }

    // ===== 6. VENDORS =====
    if ((await m.countBy(Vendor, { companyId: company.id })) === 0) {
      const vendors = [
        { name: 'Habib Oil Mills', contact: 'Mr. Habib', email: 'orders@habiboil.pk', product: 'Cooking oil manufacturer' },
        { name: 'Pak Detergent Industries', contact: 'Mr. Rashid', email: 'sales@pakdetergent.pk', product: 'Detergent powder & liquid' },
        { name: 'Sufi Cooking Oil', contact: 'Mr. Sufi', email: 'supply@sufioil.pk', product: 'Cooking oil & ghee' },
        { name: 'Bright Chemical Works', contact: 'Mr. Farooq', email: 'info@brightchem.pk', product: 'Dishwash & surface cleaners' },
        { name: 'National Packaging Co', contact: 'Mr. Yousaf', email: 'orders@natpack.pk', product: 'Packaging materials' },
      ];
      await m.save(vendors.map((v, i) => m.create(Vendor, {
        companyId: company!.id, companyName: v.name, contactPerson: v.contact, email: v.email,
        phone: '+92-42-3576' + (1000 + i * 137), address: { city: 'Lahore', country: 'Pakistan' },
        paymentTerms: 'net30', taxId: null, defaultExpenseAccountId: null, balance: '0', isActive: true, notes: v.product,
      })));
      console.log('  ✓ 5 vendors created');
    }

    // ===== 7. INVENTORY ITEMS =====
    let items: InventoryItem[] = [];
    if ((await m.countBy(InventoryItem, { companyId: company.id })) === 0) {
      const products = [
        { sku: 'CO-HABIB-5L', name: 'Habib Cooking Oil 5L', cat: 'Cooking Oil', cost: '1850', sell: '2100', qty: '450', unit: 'bottle' },
        { sku: 'CO-HABIB-1L', name: 'Habib Cooking Oil 1L', cat: 'Cooking Oil', cost: '420', sell: '480', qty: '1200', unit: 'bottle' },
        { sku: 'CO-SUFI-5L', name: 'Sufi Cooking Oil 5L', cat: 'Cooking Oil', cost: '1750', sell: '1980', qty: '380', unit: 'bottle' },
        { sku: 'CO-SUFI-1L', name: 'Sufi Cooking Oil 1L', cat: 'Cooking Oil', cost: '400', sell: '450', qty: '950', unit: 'bottle' },
        { sku: 'CO-DALDA-2.5', name: 'Dalda Banaspati Ghee 2.5kg', cat: 'Cooking Oil', cost: '1350', sell: '1520', qty: '320', unit: 'tin' },
        { sku: 'DT-SURF-1KG', name: 'Surf Excel 1kg', cat: 'Detergent', cost: '380', sell: '450', qty: '800', unit: 'pack' },
        { sku: 'DT-BONUS-1KG', name: 'Bonus Tristar 1kg', cat: 'Detergent', cost: '290', sell: '340', qty: '1100', unit: 'pack' },
        { sku: 'DT-BRITE-1KG', name: 'Brite Total 1kg', cat: 'Detergent', cost: '310', sell: '365', qty: '650', unit: 'pack' },
        { sku: 'DT-ARIEL-500', name: 'Ariel Matic 500g', cat: 'Detergent', cost: '260', sell: '310', qty: '500', unit: 'pack' },
        { sku: 'DW-LEM-750', name: 'Lemon Max Dishwash 750ml', cat: 'Dishwash', cost: '180', sell: '220', qty: '420', unit: 'bottle' },
        { sku: 'DW-VIM-500', name: 'Vim Dishwash Bar 500g', cat: 'Dishwash', cost: '120', sell: '150', qty: '750', unit: 'bar' },
        { sku: 'CL-HARPIC-500', name: 'Harpic Original 500ml', cat: 'Cleaners', cost: '230', sell: '280', qty: '340', unit: 'bottle' },
      ];
      items = await m.save(products.map((p) => m.create(InventoryItem, {
        companyId: company!.id, sku: p.sku, name: p.name, description: null, category: p.cat,
        unitOfMeasure: p.unit, costMethod: 'average', unitCost: p.cost, sellingPrice: p.sell,
        quantityOnHand: p.qty, quantityOnOrder: '0', quantityCommitted: '0', reorderPoint: '100',
        reorderQuantity: '200', minStock: '50', maxStock: '2000', sourceAgencyId: null, locationId: null,
        serialTracking: false, lotTracking: false, barcodeData: null, isActive: true,
      })));
      console.log('  ✓ 12 inventory items created');
    } else {
      items = await m.find(InventoryItem, { where: { companyId: company.id } });
    }

    // ===== 8. DELIVERY PERSONNEL PROFILES =====
    const personnelProfiles = [
      { user: saim, vehicleType: 'pickup', vehicleNumber: 'LEC-8832', zones: ['Lahore-West', 'Lahore-South'], maxLoad: '500', totalDeliveries: 203, onTimeRate: '91.20' },
      { user: haseeb, vehicleType: 'motorcycle', vehicleNumber: 'LEA-4521', zones: ['Lahore-Central', 'Lahore-East'], maxLoad: '200', totalDeliveries: 156, onTimeRate: '94.50' },
    ];
    for (const pp of personnelProfiles) {
      let existing = await m.findOneBy(DeliveryPersonnelProfile, { userId: pp.user.id });
      if (!existing) existing = m.create(DeliveryPersonnelProfile, { userId: pp.user.id, companyId: company.id });
      existing.companyId = company.id;
      existing.vehicleType = pp.vehicleType;
      existing.vehicleNumber = pp.vehicleNumber;
      existing.zones = pp.zones;
      existing.maxLoad = pp.maxLoad;
      existing.currentLoad = '0';
      existing.isAvailable = true;
      existing.status = 'active';
      existing.rating = '4.80';
      existing.totalDeliveries = pp.totalDeliveries;
      existing.onTimeRate = pp.onTimeRate;
      await m.save(existing);
    }
    console.log('  ✓ Delivery personnel profiles upserted');

    // ===== 9. SHADOW INVENTORY =====
    const findItem = (partial: string) => items.find((i) => i.name.toLowerCase().includes(partial.toLowerCase())) ?? items[0];
    const shadowEntries = [
      { personnelId: saim.id, item: findItem('Habib Cooking Oil 1L'), itemName: 'Habib Oil 1L', qty: '20' },
      { personnelId: saim.id, item: findItem('Dalda'), itemName: 'Dalda Ghee 2.5kg', qty: '10' },
      { personnelId: haseeb.id, item: findItem('Sufi Cooking Oil 5L'), itemName: 'Sufi Oil 5L', qty: '0' },
    ];
    for (const se of shadowEntries) {
      await m.save(m.create(ShadowInventorySnapshot, {
        companyId: company.id, personnelId: se.personnelId, itemId: se.item.id, itemName: se.itemName,
        originalQty: se.qty === '0' ? '8' : se.qty, currentQty: se.qty, lastSyncAt: new Date(), syncStatus: 'synced',
      }));
    }
    console.log('  ✓ Shadow inventory snapshots seeded');

    // ===== 10. AGENCIES =====
    await m.delete(Agency, { companyId: company.id });
    const [daldaAgency, suffeeOilAgency, suffeeDetAgency] = await m.save([
      m.create(Agency, { companyId: company.id, name: 'Dalda Cooking Oil', type: 'distribution', description: 'Dalda Foods — cooking oil supplier warehouse', address: { street: 'Kot Lakhpat Industrial Area', city: 'Lahore', country: 'Pakistan' }, contact: { phone: '+92-42-35131000', email: 'supply@dalda.pk' }, isConnected: true, lastSyncAt: new Date() }),
      m.create(Agency, { companyId: company.id, name: 'Suffee Cooking Oil', type: 'distribution', description: 'Sufi Group — cooking oil warehouse', address: { street: 'Sundar Industrial Estate', city: 'Lahore', country: 'Pakistan' }, contact: { phone: '+92-42-37810000', email: 'supply@sufigroup.pk' }, isConnected: true, lastSyncAt: new Date() }),
      m.create(Agency, { companyId: company.id, name: 'Suffee Detergents', type: 'distribution', description: 'Sufi Group — detergents warehouse', address: { street: 'Sundar Industrial Estate', city: 'Lahore', country: 'Pakistan' }, contact: { phone: '+92-42-37810001', email: 'detergents@sufigroup.pk' }, isConnected: true, lastSyncAt: new Date() }),
    ]);
    for (const item of items) {
      let agencyId: string | null = null;
      if (item.sku.includes('DALDA')) agencyId = daldaAgency.id;
      else if (item.sku.startsWith('CO-')) agencyId = suffeeOilAgency.id;
      else if (item.sku.startsWith('DT-') || item.sku.startsWith('DW-') || item.sku.startsWith('CL-')) agencyId = suffeeDetAgency.id;
      if (agencyId) await m.update(InventoryItem, { id: item.id }, { sourceAgencyId: agencyId });
    }
    console.log('  ✓ 3 agencies created & linked to inventory');

    // ===== 11. DELIVERIES + INVENTORY APPROVALS =====
    const allCustomers = await m.find(Customer, { where: { companyId: company.id } });
    const today = ymd(new Date());
    const yesterday = ymd(new Date(Date.now() - 86400000));
    const deliverySeedData = [
      { refNo: 'DEL-1001', dp: saim, status: 'in_transit' as const, customerName: 'Tariq General Store', zone: 'Lahore-West', priority: 'high' as const, date: today, notes: 'Handle with care', items: [{ itemName: 'Habib Oil 1L', qty: 20, price: '480' }, { itemName: 'Dalda Ghee 2.5kg', qty: 10, price: '1520' }] },
      { refNo: 'DEL-1002', dp: saim, status: 'pending' as const, customerName: 'Al-Madina Mart', zone: 'Lahore-South', priority: 'medium' as const, date: today, notes: null, items: [{ itemName: 'Surf Excel 1kg', qty: 15, price: '450' }] },
      { refNo: 'DEL-1003', dp: haseeb, status: 'delivered' as const, customerName: 'City Wholesale', zone: 'Lahore-Central', priority: 'high' as const, date: yesterday, notes: 'All items received', items: [{ itemName: 'Sufi Oil 5L', qty: 8, price: '1980' }] },
      { refNo: 'DEL-1004', dp: haseeb, status: 'pending' as const, customerName: 'Noor Enterprises', zone: 'Lahore-East', priority: 'low' as const, date: today, notes: null, items: [{ itemName: 'Bonus Tristar 1kg', qty: 25, price: '340' }] },
      { refNo: 'DEL-1005', dp: null, status: 'unassigned' as const, customerName: 'Punjab Mart', zone: 'Lahore-West', priority: 'medium' as const, date: today, notes: 'Needs assignment', items: [{ itemName: 'Harpic Original 500ml', qty: 50, price: '280' }] },
    ];
    const seededDeliveries: Record<string, Delivery> = {};
    for (const dd of deliverySeedData) {
      const custId = allCustomers.length > 0 ? allCustomers[deliverySeedData.indexOf(dd) % allCustomers.length].id : admin.id;
      const delivery = await m.save(m.create(Delivery, {
        companyId: company.id, customerId: custId, customerName: dd.customerName, zone: dd.zone,
        referenceNo: dd.refNo, personnelId: dd.dp?.id ?? null, status: dd.status, priority: dd.priority,
        preferredDate: dd.date, assignedAt: dd.dp ? new Date() : null,
        completedAt: dd.status === 'delivered' ? new Date() : null, notes: dd.notes, cancelReason: null, createdBy: admin.id,
      }));
      seededDeliveries[dd.refNo] = delivery;
      for (let idx = 0; idx < dd.items.length; idx++) {
        const it = dd.items[idx];
        const inv = items[(idx + deliverySeedData.indexOf(dd)) % items.length];
        await m.save(m.create(DeliveryItem, {
          deliveryId: delivery.id, itemId: inv.id, itemName: it.itemName, agencyId: null, agencyName: null,
          quantity: String(it.qty), orderedQty: String(it.qty),
          deliveredQty: dd.status === 'delivered' ? String(it.qty) : '0', returnedQty: '0', unitPrice: it.price,
        }));
      }
    }
    console.log('  ✓ 5 deliveries seeded');

    const del1003 = seededDeliveries['DEL-1003'];
    const approvalReq1 = await m.save(m.create(InventoryUpdateRequest, {
      companyId: company.id, deliveryId: del1003.id, personnelId: haseeb.id, status: 'approved',
      submittedAt: new Date(Date.now() - 86400000), reviewedAt: new Date(Date.now() - 43200000), reviewedBy: admin.id,
      approvalNotes: 'All items verified', rejectReason: null, deliveryReference: 'DEL-1003', personnelName: 'Haseeb Ahmed',
      routeLabel: 'Lahore-Central', shadowStatus: 'synced', reviewerComment: 'Approved — all quantities match',
      proofSignedBy: 'City Wholesale Manager', proofVerificationMethod: 'bill_photo',
      proofBillPhotoUrl: 'https://placehold.co/400x600/png', proofBillPhotoCapturedAt: new Date(Date.now() - 86400000),
    }));
    await m.save(m.create(InventoryUpdateRequestLine, {
      requestId: approvalReq1.id, itemId: items[2].id, itemName: 'Sufi Oil 5L',
      beforeQty: '100', deliveredQty: '8', returnedQty: '0', afterQty: '92',
    }));

    const del1001 = seededDeliveries['DEL-1001'];
    const approvalReq2 = await m.save(m.create(InventoryUpdateRequest, {
      companyId: company.id, deliveryId: del1001.id, personnelId: saim.id, status: 'pending',
      submittedAt: new Date(), reviewedAt: null, reviewedBy: null, approvalNotes: null, rejectReason: null,
      deliveryReference: 'DEL-1001', personnelName: 'Saim Raza', routeLabel: 'Lahore-West', shadowStatus: 'pending',
      reviewerComment: null, proofSignedBy: 'Tariq General Store', proofVerificationMethod: 'bill_photo',
      proofBillPhotoUrl: 'https://placehold.co/400x600/png', proofBillPhotoCapturedAt: new Date(),
    }));
    await m.save([
      m.create(InventoryUpdateRequestLine, { requestId: approvalReq2.id, itemId: items[1].id, itemName: 'Habib Oil 1L', beforeQty: '200', deliveredQty: '20', returnedQty: '0', afterQty: '180' }),
      m.create(InventoryUpdateRequestLine, { requestId: approvalReq2.id, itemId: items[4].id, itemName: 'Dalda Ghee 2.5kg', beforeQty: '50', deliveredQty: '10', returnedQty: '0', afterQty: '40' }),
    ]);
    console.log('  ✓ 2 inventory approval requests seeded');

    // ===== 12. TAX RATES =====
    if ((await m.countBy(TaxRate, { companyId: company.id })) === 0) {
      await m.save([
        m.create(TaxRate, { companyId: company.id, name: 'GST (17%)', rate: '17', type: 'sales' as any, authority: 'FBR', isActive: true, isDefault: true }),
        m.create(TaxRate, { companyId: company.id, name: 'Withholding Tax (4.5%)', rate: '4.5', type: 'income' as any, authority: 'FBR', isActive: true, isDefault: false }),
        m.create(TaxRate, { companyId: company.id, name: 'Excise Duty (5%)', rate: '5', type: 'sales' as any, authority: 'Provincial', isActive: true, isDefault: false }),
        m.create(TaxRate, { companyId: company.id, name: 'Zero-rated (Export)', rate: '0', type: 'sales' as any, authority: 'FBR', isActive: true, isDefault: false }),
      ]);
      console.log('  ✓ 4 tax rates created');
    }

    // ===== 13. INVOICES — 2 YEARS (generated monthly) =====
    const allCusts = await m.find(Customer, { where: { companyId: company.id } });
    const allVends = await m.find(Vendor, { where: { companyId: company.id } });
    const accounts = await m.find(Account, { where: { companyId: company.id } });
    const salesAccount = accounts.find((a) => a.name.includes('Sales') || a.type === 'revenue') ?? accounts[0];
    const expenseAccount = accounts.find((a) => a.type === 'expense') ?? accounts[0];

    const now = new Date();
    const MONTHS = 24;
    let invSeq = 0;
    for (let k = MONTHS - 1; k >= 0; k--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - k, 12);
      const ageDays = Math.floor((now.getTime() - monthDate.getTime()) / 86400000);
      for (let j = 0; j < 2; j++) {
        invSeq++;
        const cust = allCusts[invSeq % allCusts.length];
        const it1 = items[(invSeq * 2) % items.length];
        const it2 = items[(invSeq * 2 + 1) % items.length];
        const lines = [
          { desc: it1.name, qty: 10 + (invSeq % 5) * 5, price: +it1.sellingPrice },
          { desc: it2.name, qty: 5 + (invSeq % 4) * 4, price: +it2.sellingPrice },
        ];
        let status: string; let paidFrac: number;
        if (ageDays > 120) { status = 'paid'; paidFrac = 1; }
        else if (ageDays > 60) { if (invSeq % 3 === 0) { status = 'partial'; paidFrac = 0.5; } else { status = 'paid'; paidFrac = 1; } }
        else {
          const opts: Array<[string, number]> = [['paid', 1], ['partial', 0.5], ['sent', 0], ['overdue', 0]];
          const o = opts[invSeq % 4]; status = o[0]; paidFrac = o[1];
        }
        const sub = lines.reduce((s, l) => s + l.qty * l.price, 0);
        const tax = t17(sub);
        const tot = +(sub + tax).toFixed(2);
        const paid = +(tot * paidFrac).toFixed(2);
        const bal = +(tot - paid).toFixed(2);
        const num = `INV-${monthDate.getFullYear()}-${String(invSeq).padStart(4, '0')}`;
        const invoice = await m.save(m.create(Invoice, {
          companyId: company.id, customerId: cust.id, invoiceNumber: num,
          invoiceDate: ymd(monthDate), dueDate: ymd(addDays(monthDate, 30)),
          subtotal: String(sub), discountType: 'none', discountValue: '0', discountAmount: '0',
          taxAmount: String(tax), total: String(tot), amountPaid: String(paid), balance: String(bal),
          status: status as any, notes: `Invoice for ${cust.name}`, paymentTerms: 'net30', createdBy: admin.id,
        }));
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const lineSub = l.qty * l.price;
          await m.save(m.create(InvoiceLineItem, {
            invoiceId: invoice.id, description: l.desc, quantity: String(l.qty), unitPrice: String(l.price),
            taxRate: '17', taxAmount: String(t17(lineSub)), lineTotal: String(lt17(lineSub)),
            accountId: salesAccount?.id ?? null, lineOrder: i,
          }));
        }
      }
    }
    console.log(`  ✓ ${invSeq} invoices created across ${MONTHS} months (2 years)`);

    // ===== 14. BILLS — 2 YEARS (generated monthly) =====
    let billSeq = 0;
    for (let k = MONTHS - 1; k >= 0; k--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - k, 8);
      const ageDays = Math.floor((now.getTime() - monthDate.getTime()) / 86400000);
      billSeq++;
      const vend = allVends[billSeq % allVends.length];
      const it = items[(billSeq * 3) % items.length];
      const qty = 200 + (billSeq % 6) * 50;
      const lines = [{ desc: `${it.name} — bulk purchase (${qty} units)`, amount: qty * +it.unitCost }];
      let status: string; let paidFrac: number;
      if (ageDays > 90) { status = 'paid'; paidFrac = 1; }
      else if (ageDays > 45) { if (billSeq % 3 === 0) { status = 'partial'; paidFrac = 0.5; } else { status = 'paid'; paidFrac = 1; } }
      else { const opts: Array<[string, number]> = [['paid', 1], ['open', 0], ['partial', 0.4], ['open', 0]]; const o = opts[billSeq % 4]; status = o[0]; paidFrac = o[1]; }
      const sub = lines.reduce((s, l) => s + l.amount, 0);
      const tax = t17(sub);
      const tot = +(sub + tax).toFixed(2);
      const paid = +(tot * paidFrac).toFixed(2);
      const bal = +(tot - paid).toFixed(2);
      const num = `BILL-${monthDate.getFullYear()}-${String(billSeq).padStart(4, '0')}`;
      const bill = await m.save(m.create(Bill, {
        companyId: company.id, vendorId: vend.id, billNumber: num, billDate: ymd(monthDate),
        dueDate: ymd(addDays(monthDate, 30)), subtotal: String(sub), taxAmount: String(tax), total: String(tot),
        amountPaid: String(paid), balance: String(bal), status: status as any,
        memo: `Purchase from ${vend.companyName}`, createdBy: admin.id,
      } as any));
      for (let i = 0; i < lines.length; i++) {
        await m.save(m.create(BillLineItem, {
          billId: bill.id, accountId: expenseAccount?.id ?? null, description: lines[i].desc,
          amount: String(lines[i].amount), taxRate: '17', lineOrder: i,
        } as any));
      }
    }
    console.log(`  ✓ ${billSeq} bills created across ${MONTHS} months (2 years)`);

    // ===== 15. PURCHASE ORDERS =====
    type POLine = { itemIdx: number; desc: string; ordQty: number; recQty: number; cost: number };
    type PODef = { num: string; v: number; status: string; orderDate: string; expectedDate: string; notes: string; lines: POLine[] };
    const poDefs: PODef[] = [
      { num: 'PO-2025-001', v: 0, status: 'received', orderDate: '2025-06-01', expectedDate: '2025-06-10', notes: 'Habib Oil June restock', lines: [{ itemIdx: 0, desc: 'Habib Cooking Oil 5L — 50 units', ordQty: 50, recQty: 50, cost: 1850 }] },
      { num: 'PO-2025-002', v: 1, status: 'received', orderDate: '2025-09-05', expectedDate: '2025-09-15', notes: 'Detergent bulk', lines: [{ itemIdx: 5, desc: 'Surf Excel 1kg — 500 units', ordQty: 500, recQty: 500, cost: 380 }] },
      { num: 'PO-2025-003', v: 2, status: 'partial', orderDate: '2025-12-01', expectedDate: '2025-12-15', notes: 'Sufi Oil replenishment', lines: [{ itemIdx: 2, desc: 'Sufi Cooking Oil 5L — 200 units', ordQty: 200, recQty: 120, cost: 1750 }] },
      { num: 'PO-2026-001', v: 3, status: 'sent', orderDate: '2026-03-01', expectedDate: '2026-03-15', notes: 'Cleaners Q1 restock', lines: [{ itemIdx: 11, desc: 'Harpic Original 500ml — 300 units', ordQty: 300, recQty: 0, cost: 230 }] },
      { num: 'PO-2026-002', v: 1, status: 'draft', orderDate: ymd(addDays(now, -10)), expectedDate: ymd(addDays(now, 10)), notes: 'Detergent draft order', lines: [{ itemIdx: 8, desc: 'Ariel Matic 500g — 300 units', ordQty: 300, recQty: 0, cost: 260 }] },
    ];
    for (const def of poDefs) {
      const sub = def.lines.reduce((s, l) => s + l.ordQty * l.cost, 0);
      const tax = t17(sub);
      const tot = +(sub + tax).toFixed(2);
      const po = await m.save(m.create(PurchaseOrder, {
        companyId: company.id, vendorId: allVends[def.v % allVends.length].id, poNumber: def.num,
        orderDate: def.orderDate, expectedDate: def.expectedDate, subtotal: String(sub), taxAmount: String(tax),
        total: String(tot), status: def.status as any, notes: def.notes,
      } as any));
      for (let i = 0; i < def.lines.length; i++) {
        const l = def.lines[i];
        const lineSub = l.ordQty * l.cost;
        await m.save(m.create(PurchaseOrderLine, {
          orderId: po.id, itemId: items[l.itemIdx]?.id ?? null, description: l.desc,
          orderedQty: String(l.ordQty), receivedQty: String(l.recQty), unitCost: String(l.cost),
          taxRate: '17', lineTotal: String(lt17(lineSub)), accountId: expenseAccount?.id ?? null, lineOrder: i,
        } as any));
      }
    }
    console.log(`  ✓ ${poDefs.length} purchase orders created`);

    // ===== DONE =====
    console.log('\n' + '='.repeat(60));
    console.log('  MetroMatrix demo seed completed!');
    console.log('='.repeat(60));
    console.log('  Login Credentials:');
    console.log(`    Admin:        ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log(`    Delivery #1:  saim@metromatrix.com / ${DP_PASSWORD}`);
    console.log(`    Delivery #2:  haseeb@metromatrix.com / ${DP_PASSWORD}`);
    console.log(`    Invite code:  ${company.inviteCode}`);
    console.log('='.repeat(60) + '\n');
  });

  await ds.destroy();
}

run().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
