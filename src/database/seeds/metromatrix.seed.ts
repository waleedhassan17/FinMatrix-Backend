/**
 * MetroMatrix Production Seed Script
 * ===================================
 * Usage:  npm run seed:metromatrix
 *
 * Creates a complete, production-ready dataset for MetroMatrix —
 * a multi-product distribution agency (cooking oil, detergents, FMCG).
 *
 * After running, you can log in and test EVERY feature end-to-end:
 *
 *   Admin:     metromatrix@gmail.com     / 123456
 *   DP #1:     saim@metromatrix.com      / 123456
 *   DP #2:     haseeb@metromatrix.com    / 123456
 *
 *   Company invite code: printed in console output.
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
import { Estimate } from '../../modules/estimates/entities/estimate.entity';
import { EstimateLineItem } from '../../modules/estimates/entities/estimate-line-item.entity';
import { CreditMemo } from '../../modules/credit-memos/entities/credit-memo.entity';
import { CreditMemoLine } from '../../modules/credit-memos/entities/credit-memo-line.entity';
import { SalesOrder } from '../../modules/sales-orders/entities/sales-order.entity';
import { SalesOrderLine } from '../../modules/sales-orders/entities/sales-order-line.entity';
import { PurchaseOrder } from '../../modules/purchase-orders/entities/purchase-order.entity';
import { PurchaseOrderLine } from '../../modules/purchase-orders/entities/purchase-order-line.entity';
import { Budget } from '../../modules/budgets/entities/budget.entity';
import { PayrollRun } from '../../modules/payroll/entities/payroll-run.entity';
import { Employee } from '../../modules/employees/entities/employee.entity';
import { Paystub } from '../../modules/payroll/entities/paystub.entity';
import { JournalEntry } from '../../modules/journal-entries/entities/journal-entry.entity';
import { JournalEntryLine } from '../../modules/journal-entries/entities/journal-entry-line.entity';
import { BankAccount } from '../../modules/banking/entities/bank-account.entity';
import { BankTransaction } from '../../modules/banking/entities/bank-transaction.entity';
import { TaxRate } from '../../modules/tax/entities/tax-rate.entity';
import { Notification } from '../../modules/notifications/entities/notification.entity';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
} from '../../modules/accounts/accounts.constants';
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

// =====================================================================
// PASSWORDS
// =====================================================================
const ADMIN_EMAIL    = 'metromatrix@gmail.com';
const ADMIN_PASSWORD = '123456';
const DP_PASSWORD    = '123456';

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
  console.log('> Connected. Seeding MetroMatrix production data…\n');

  // Schema fixes + cleanup — run OUTSIDE the transaction
  await ds.query(`ALTER TABLE shadow_inventory_snapshots ADD COLUMN IF NOT EXISTS item_name varchar(200)`).catch(() => {});

  // Determine companyId for cleanup
  const companyRow = await ds.query(`SELECT id FROM companies WHERE name = 'MetroMatrix' LIMIT 1`);
  if (companyRow.length > 0) {
    const cid = companyRow[0].id;
    await ds.query(`DELETE FROM inventory_update_request_lines WHERE request_id IN (SELECT id FROM inventory_update_requests WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM inventory_update_requests WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM delivery_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM deliveries WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM shadow_inventory_snapshots WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM estimate_line_items WHERE estimate_id IN (SELECT id FROM estimates WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM estimates WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM credit_memo_lines WHERE credit_memo_id IN (SELECT id FROM credit_memos WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM credit_memos WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM payment_applications WHERE payment_id IN (SELECT id FROM payments WHERE company_id = $1)`, [cid]).catch(() => {});
    await ds.query(`DELETE FROM payments WHERE company_id = $1`, [cid]).catch(() => {});
    await ds.query(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM invoices WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM bills WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM sales_order_lines WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM sales_orders WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM purchase_order_lines WHERE order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM journal_entry_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`, [cid]);
    await ds.query(`DELETE FROM journal_entries WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM bank_transactions WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM bank_accounts WHERE company_id = $1`, [cid]);
    await ds.query(`DELETE FROM notifications WHERE company_id = $1`, [cid]).catch(() => {});
    await ds.query(`DELETE FROM tax_rates WHERE company_id = $1`, [cid]).catch(() => {});
    console.log('  ✓ Cleaned up all transactional data for fresh seed');
  }

  await ds.transaction(async (m) => {
    // =================================================================
    // 1. USERS
    // =================================================================
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const dpHash = await bcrypt.hash(DP_PASSWORD, 12);

    let admin = await m.findOneBy(User, { email: ADMIN_EMAIL });
    if (!admin) {
      admin = await m.save(
        m.create(User, {
          email: ADMIN_EMAIL,
          passwordHash: adminHash,
          displayName: 'MetroMatrix Admin',
          phone: '+92-300-1234567',
          role: 'admin',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
      console.log(`  ✓ Admin user created: ${ADMIN_EMAIL}`);
    } else {
      admin.passwordHash = adminHash;
      admin.isActive = true;
      if (admin.role !== 'admin') admin.role = 'admin';
      await m.save(admin);
      console.log(`  ✓ Admin user exists, password updated: ${ADMIN_EMAIL}`);
    }

    let saim = await m.findOneBy(User, { email: 'saim@metromatrix.com' });
    if (!saim) {
      saim = await m.save(
        m.create(User, {
          email: 'saim@metromatrix.com',
          passwordHash: dpHash,
          displayName: 'Saim Raza',
          phone: '+92-321-5550101',
          role: 'delivery',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
      console.log('  ✓ DP user created: saim@metromatrix.com');
    } else {
      saim.passwordHash = dpHash;
      saim.isActive = true;
      await m.save(saim);
      console.log('  ✓ DP Saim exists, password updated');
    }

    let haseeb = await m.findOneBy(User, { email: 'haseeb@metromatrix.com' });
    if (!haseeb) {
      haseeb = await m.save(
        m.create(User, {
          email: 'haseeb@metromatrix.com',
          passwordHash: dpHash,
          displayName: 'Haseeb Ahmed',
          phone: '+92-321-5550202',
          role: 'delivery',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
      console.log('  ✓ DP user created: haseeb@metromatrix.com');
    } else {
      haseeb.passwordHash = dpHash;
      haseeb.isActive = true;
      await m.save(haseeb);
      console.log('  ✓ DP Haseeb exists, password updated');
    }

    // =================================================================
    // 2. COMPANY
    // =================================================================
    let company = await m.findOne(Company, { where: { name: 'MetroMatrix' } });
    if (!company) {
      company = await m.save(
        m.create(Company, {
          name: 'MetroMatrix',
          industry: 'FMCG Distribution',
          address: {
            street: '45-B, Industrial Area, Sundar Road',
            city: 'Lahore',
            state: 'Punjab',
            postalCode: '54000',
            country: 'Pakistan',
          },
          phone: '+92-42-35761234',
          email: 'info@metromatrix.com',
          taxId: 'NTN-7842391',
          inviteCode: generateInviteCode(6),
          logo: null,
          createdBy: admin.id,
          status: 'active',
        }),
      );
      console.log(`  ✓ Company "MetroMatrix" created (invite: ${company.inviteCode})`);
    } else {
      // Ensure status is set to 'active' for existing records
      if (company.status !== 'active') {
        company.status = 'active';
        await m.save(company);
        console.log(`  ✓ Company "MetroMatrix" status updated to 'active' (invite: ${company.inviteCode})`);
      } else {
        console.log(`  ✓ Company "MetroMatrix" exists (invite: ${company.inviteCode})`);
      }
    }

    // =================================================================
    // 3. MEMBERSHIPS
    // =================================================================
    const memberships: Array<{ user: User; role: 'admin' | 'delivery' }> = [
      { user: admin, role: 'admin' },
      { user: saim, role: 'delivery' },
      { user: haseeb, role: 'delivery' },
    ];
    for (const mem of memberships) {
      const existing = await m.findOne(UserCompany, {
        where: { userId: mem.user.id, companyId: company.id },
      });
      if (!existing) {
        await m.save(
          m.create(UserCompany, {
            userId: mem.user.id,
            companyId: company.id,
            role: mem.role,
          }),
        );
      }
    }
    // Set default company
    for (const u of [admin, saim, haseeb]) {
      if (!u.defaultCompanyId) {
        u.defaultCompanyId = company.id;
        await m.save(u);
      }
    }
    console.log('  ✓ Memberships linked');

    // =================================================================
    // 4. CHART OF ACCOUNTS
    // =================================================================
    const existingAccounts = await m.countBy(Account, { companyId: company.id });
    if (existingAccounts === 0) {
      await m.save(
        DEFAULT_CHART_OF_ACCOUNTS.map((a) =>
          m.create(Account, {
            companyId: company!.id,
            accountNumber: a.accountNumber,
            name: a.name,
            type: a.type,
            subType: a.subType,
            parentId: null,
            description: null,
            openingBalance: '0',
            balance: '0',
            isActive: true,
          }),
        ),
      );
      console.log('  ✓ Chart of accounts seeded (14 accounts)');
    }

    // =================================================================
    // 5. CUSTOMERS (retail shops that buy from MetroMatrix)
    // =================================================================
    const existingCustomers = await m.countBy(Customer, { companyId: company.id });
    if (existingCustomers === 0) {
      const customers = [
        { name: 'Tariq General Store', city: 'Lahore',    phone: '+92-300-4441111', email: 'tariq.store@gmail.com' },
        { name: 'Al-Madina Mart',      city: 'Lahore',    phone: '+92-301-4442222', email: 'almadina.mart@gmail.com' },
        { name: 'Iqbal Grocery',       city: 'Faisalabad', phone: '+92-302-4443333', email: 'iqbal.grocery@gmail.com' },
        { name: 'Rehman Superstore',   city: 'Rawalpindi', phone: '+92-303-4444444', email: 'rehman.super@gmail.com' },
        { name: 'City Wholesale',      city: 'Multan',    phone: '+92-304-4445555', email: 'city.wholesale@gmail.com' },
        { name: 'Bismillah Trading',   city: 'Gujranwala', phone: '+92-305-4446666', email: 'bismillah.tr@gmail.com' },
        { name: 'Noor Enterprises',    city: 'Sialkot',   phone: '+92-306-4447777', email: 'noor.ent@gmail.com' },
        { name: 'Punjab Mart',         city: 'Lahore',    phone: '+92-307-4448888', email: 'punjab.mart@gmail.com' },
      ];
      await m.save(
        customers.map((c) =>
          m.create(Customer, {
            companyId: company!.id,
            name: c.name,
            company: c.name,
            email: c.email,
            phone: c.phone,
            billingAddress: { city: c.city, country: 'Pakistan' },
            shippingAddress: { city: c.city, country: 'Pakistan' },
            creditLimit: '100000',
            paymentTerms: 'net30',
            balance: '0',
            isActive: true,
            notes: null,
          }),
        ),
      );
      console.log('  ✓ 8 customers created');
    }

    // =================================================================
    // 6. VENDORS (suppliers to MetroMatrix)
    // =================================================================
    const existingVendors = await m.countBy(Vendor, { companyId: company.id });
    if (existingVendors === 0) {
      const vendors = [
        { name: 'Habib Oil Mills',           contact: 'Mr. Habib',    email: 'orders@habiboil.pk',         product: 'Cooking oil manufacturer' },
        { name: 'Pak Detergent Industries',  contact: 'Mr. Rashid',   email: 'sales@pakdetergent.pk',      product: 'Detergent powder & liquid' },
        { name: 'Sufi Cooking Oil',          contact: 'Mr. Sufi',     email: 'supply@sufioil.pk',           product: 'Cooking oil & ghee' },
        { name: 'Bright Chemical Works',     contact: 'Mr. Farooq',   email: 'info@brightchem.pk',          product: 'Dishwash & surface cleaners' },
        { name: 'National Packaging Co',     contact: 'Mr. Yousaf',   email: 'orders@natpack.pk',           product: 'Packaging materials' },
      ];
      await m.save(
        vendors.map((v) =>
          m.create(Vendor, {
            companyId: company!.id,
            companyName: v.name,
            contactPerson: v.contact,
            email: v.email,
            phone: '+92-42-3576' + Math.floor(1000 + Math.random() * 9000),
            address: { city: 'Lahore', country: 'Pakistan' },
            paymentTerms: 'net30',
            taxId: null,
            defaultExpenseAccountId: null,
            balance: '0',
            isActive: true,
            notes: v.product,
          }),
        ),
      );
      console.log('  ✓ 5 vendors created');
    }

    // =================================================================
    // 7. INVENTORY ITEMS — real Pakistani FMCG products
    // =================================================================
    const existingItems = await m.countBy(InventoryItem, { companyId: company.id });
    let items: InventoryItem[] = [];
    if (existingItems === 0) {
      const products = [
        // Cooking Oils
        { sku: 'CO-HABIB-5L',  name: 'Habib Cooking Oil 5L',       cat: 'Cooking Oil', cost: '1850', sell: '2100', qty: '450', unit: 'bottle' },
        { sku: 'CO-HABIB-1L',  name: 'Habib Cooking Oil 1L',       cat: 'Cooking Oil', cost: '420',  sell: '480',  qty: '1200', unit: 'bottle' },
        { sku: 'CO-SUFI-5L',   name: 'Sufi Cooking Oil 5L',        cat: 'Cooking Oil', cost: '1750', sell: '1980', qty: '380', unit: 'bottle' },
        { sku: 'CO-SUFI-1L',   name: 'Sufi Cooking Oil 1L',        cat: 'Cooking Oil', cost: '400',  sell: '450',  qty: '950', unit: 'bottle' },
        { sku: 'CO-DALDA-2.5', name: 'Dalda Banaspati Ghee 2.5kg', cat: 'Cooking Oil', cost: '1350', sell: '1520', qty: '320', unit: 'tin' },
        // Detergents
        { sku: 'DT-SURF-1KG',  name: 'Surf Excel 1kg',            cat: 'Detergent',   cost: '380',  sell: '450',  qty: '800', unit: 'pack' },
        { sku: 'DT-BONUS-1KG', name: 'Bonus Tristar 1kg',         cat: 'Detergent',   cost: '290',  sell: '340',  qty: '1100', unit: 'pack' },
        { sku: 'DT-BRITE-1KG', name: 'Brite Total 1kg',           cat: 'Detergent',   cost: '310',  sell: '365',  qty: '650', unit: 'pack' },
        { sku: 'DT-ARIEL-500', name: 'Ariel Matic 500g',          cat: 'Detergent',   cost: '260',  sell: '310',  qty: '500', unit: 'pack' },
        // Dishwash & Cleaners
        { sku: 'DW-LEM-750',   name: 'Lemon Max Dishwash 750ml',  cat: 'Dishwash',    cost: '180',  sell: '220',  qty: '420', unit: 'bottle' },
        { sku: 'DW-VIM-500',   name: 'Vim Dishwash Bar 500g',     cat: 'Dishwash',    cost: '120',  sell: '150',  qty: '750', unit: 'bar' },
        { sku: 'CL-HARPIC-500',name: 'Harpic Original 500ml',     cat: 'Cleaners',    cost: '230',  sell: '280',  qty: '340', unit: 'bottle' },
      ];
      items = await m.save(
        products.map((p) =>
          m.create(InventoryItem, {
            companyId: company!.id,
            sku: p.sku,
            name: p.name,
            description: null,
            category: p.cat,
            unitOfMeasure: p.unit,
            costMethod: 'average',
            unitCost: p.cost,
            sellingPrice: p.sell,
            quantityOnHand: p.qty,
            quantityOnOrder: '0',
            quantityCommitted: '0',
            reorderPoint: '100',
            reorderQuantity: '200',
            minStock: '50',
            maxStock: '2000',
            sourceAgencyId: null,
            locationId: null,
            serialTracking: false,
            lotTracking: false,
            barcodeData: null,
            isActive: true,
          }),
        ),
      );
      console.log('  ✓ 12 inventory items created (cooking oil, detergents, cleaners)');
    } else {
      items = await m.find(InventoryItem, { where: { companyId: company.id } });
    }

    // =================================================================
    // 8. DELIVERY PERSONNEL PROFILES
    // =================================================================
    const personnelProfiles = [
      { user: saim,   vehicleType: 'pickup',     vehicleNumber: 'LEC-8832', zones: ['Lahore-West', 'Lahore-South'],    maxLoad: '500', totalDeliveries: 203, onTimeRate: '91.20' },
      { user: haseeb, vehicleType: 'motorcycle',  vehicleNumber: 'LEA-4521', zones: ['Lahore-Central', 'Lahore-East'], maxLoad: '200', totalDeliveries: 156, onTimeRate: '94.50' },
    ];
    for (const pp of personnelProfiles) {
      let existing = await m.findOneBy(DeliveryPersonnelProfile, { userId: pp.user.id });
      if (!existing) {
        existing = m.create(DeliveryPersonnelProfile, { userId: pp.user.id, companyId: company.id });
      }
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

    // =================================================================
    // 9. SHADOW INVENTORY SNAPSHOTS (for DP mobile app)
    // =================================================================
    // Helper to find an item by partial name
    const findItem = (partial: string) => items.find(i => i.name.toLowerCase().includes(partial.toLowerCase())) ?? items[0];
    const shadowEntries = [
      // Saim: AquaPure 500ml qty=20, Dalda Oil 1L qty=10
      { personnelId: saim.id, item: findItem('Habib Cooking Oil 1L'), itemName: 'AquaPure 500ml', qty: '20' },
      { personnelId: saim.id, item: findItem('Dalda'), itemName: 'Dalda Oil 1L', qty: '10' },
      // Haseeb: Rice 5kg qty=0 (already delivered/synced)
      { personnelId: haseeb.id, item: findItem('Sufi Cooking Oil 5L'), itemName: 'Rice 5kg', qty: '0' },
    ];
    for (const se of shadowEntries) {
      await m.save(m.create(ShadowInventorySnapshot, {
        companyId: company.id,
        personnelId: se.personnelId,
        itemId: se.item.id,
        itemName: se.itemName,
        originalQty: se.qty === '0' ? '8' : se.qty,
        currentQty: se.qty,
        lastSyncAt: new Date(),
        syncStatus: 'synced',
      }));
    }
    console.log('  ✓ Shadow inventory snapshots seeded (Saim: 2 items, Haseeb: 1 item)');

    // =================================================================
    // 10. AGENCIES
    // =================================================================
    // Delete old courier-type agencies and recreate as supplier warehouses
    await m.delete(Agency, { companyId: company.id });
    const [daldaAgency, suffeeOilAgency, suffeeDetAgency] = await m.save([
      m.create(Agency, {
        companyId: company.id,
        name: 'Dalda Cooking Oil',
        type: 'distribution',
        description: 'Dalda Foods — cooking oil supplier and distribution warehouse',
        address: { street: 'Kot Lakhpat Industrial Area', city: 'Lahore', country: 'Pakistan' },
        contact: { phone: '+92-42-35131000', email: 'supply@dalda.pk' },
        isConnected: true,
        lastSyncAt: new Date(),
      }),
      m.create(Agency, {
        companyId: company.id,
        name: 'Suffee Cooking Oil',
        type: 'distribution',
        description: 'Sufi Group — cooking oil products warehouse',
        address: { street: 'Sundar Industrial Estate', city: 'Lahore', country: 'Pakistan' },
        contact: { phone: '+92-42-37810000', email: 'supply@sufigroup.pk' },
        isConnected: true,
        lastSyncAt: new Date(),
      }),
      m.create(Agency, {
        companyId: company.id,
        name: 'Suffee Detergents',
        type: 'distribution',
        description: 'Sufi Group — detergents and cleaning products warehouse',
        address: { street: 'Sundar Industrial Estate', city: 'Lahore', country: 'Pakistan' },
        contact: { phone: '+92-42-37810001', email: 'detergents@sufigroup.pk' },
        isConnected: true,
        lastSyncAt: new Date(),
      }),
    ]);
    console.log('  ✓ 3 agencies created (Dalda Cooking Oil, Suffee Cooking Oil, Suffee Detergents)');

    // Link inventory items to their source agencies
    for (const item of items) {
      let agencyId: string | null = null;
      if (item.sku.includes('DALDA')) agencyId = daldaAgency.id;
      else if (item.sku.startsWith('CO-')) agencyId = suffeeOilAgency.id; // Sufi + Habib cooking oils
      else if (item.sku.startsWith('DT-') || item.sku.startsWith('DW-') || item.sku.startsWith('CL-')) agencyId = suffeeDetAgency.id;
      if (agencyId) await m.update(InventoryItem, { id: item.id }, { sourceAgencyId: agencyId });
    }
    console.log('  ✓ Inventory items linked to supplier agencies');

    // =================================================================
    // 11. DELIVERIES — 5 specific deliveries per spec + inventory approvals
    // =================================================================
    const allCustomers = await m.find(Customer, { where: { companyId: company.id } });

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // We'll reference items by index: 0=Habib 5L, 1=Habib 1L, 2=Sufi 5L, 3=Sufi 1L, 4=Dalda, 5=Surf, ...
    const deliverySeedData = [
      {
        refNo: 'DEL-1001', dp: saim, status: 'in_transit' as const, customerName: 'Ali General Store',
        zone: 'Lahore-West', priority: 'high' as const, date: today, notes: 'Handle with care',
        items: [
          { itemName: 'AquaPure 500ml', qty: 20, price: '480' },
          { itemName: 'Dalda Oil 1L', qty: 10, price: '1520' },
        ],
      },
      {
        refNo: 'DEL-1002', dp: saim, status: 'pending' as const, customerName: 'Khan Mart',
        zone: 'Lahore-South', priority: 'medium' as const, date: today, notes: null,
        items: [
          { itemName: 'Nestlé Milk', qty: 15, price: '450' },
        ],
      },
      {
        refNo: 'DEL-1003', dp: haseeb, status: 'delivered' as const, customerName: 'City Supermarket',
        zone: 'Lahore-Central', priority: 'high' as const, date: yesterday, notes: 'All items received',
        items: [
          { itemName: 'Rice 5kg', qty: 8, price: '1980' },
        ],
      },
      {
        refNo: 'DEL-1004', dp: haseeb, status: 'pending' as const, customerName: 'Faisal Traders',
        zone: 'Lahore-East', priority: 'low' as const, date: today, notes: null,
        items: [
          { itemName: 'Sugar 1kg', qty: 25, price: '340' },
        ],
      },
      {
        refNo: 'DEL-1005', dp: null, status: 'unassigned' as const, customerName: 'New Store',
        zone: 'Lahore-West', priority: 'medium' as const, date: today, notes: 'Needs assignment',
        items: [
          { itemName: 'Tea', qty: 50, price: '310' },
        ],
      },
    ];

    const seededDeliveries: Record<string, Delivery> = {};
    for (const dd of deliverySeedData) {
      const custId = allCustomers.length > 0 ? allCustomers[Math.floor(Math.random() * allCustomers.length)].id : admin.id;
      const delivery = await m.save(
        m.create(Delivery, {
          companyId: company.id,
          customerId: custId,
          customerName: dd.customerName,
          zone: dd.zone,
          referenceNo: dd.refNo,
          personnelId: dd.dp?.id ?? null,
          status: dd.status,
          priority: dd.priority,
          preferredDate: dd.date,
          assignedAt: dd.dp ? new Date() : null,
          completedAt: dd.status === 'delivered' ? new Date() : null,
          notes: dd.notes,
          cancelReason: null,
          createdBy: admin.id,
        }),
      );
      seededDeliveries[dd.refNo] = delivery;

      for (const it of dd.items) {
        const inv = items.length > 0 ? items[Math.floor(Math.random() * items.length)] : null;
        await m.save(
          m.create(DeliveryItem, {
            deliveryId: delivery.id,
            itemId: inv?.id ?? '00000000-0000-0000-0000-000000000001',
            itemName: it.itemName,
            agencyId: null,
            agencyName: null,
            quantity: String(it.qty),
            orderedQty: String(it.qty),
            deliveredQty: dd.status === 'delivered' ? String(it.qty) : '0',
            returnedQty: '0',
            unitPrice: it.price,
          }),
        );
      }
    }
    console.log('  ✓ 5 deliveries seeded (DEL-1001..DEL-1005)');

    // =================================================================
    // 11b. INVENTORY APPROVAL REQUESTS (2 per spec)
    // =================================================================
    // 1) DEL-1003 (delivered by Haseeb) — approved
    const del1003 = seededDeliveries['DEL-1003'];
    const approvalReq1 = await m.save(
      m.create(InventoryUpdateRequest, {
        companyId: company.id,
        deliveryId: del1003.id,
        personnelId: haseeb.id,
        status: 'approved',
        submittedAt: new Date(Date.now() - 86400000),
        reviewedAt: new Date(Date.now() - 43200000),
        reviewedBy: admin.id,
        approvalNotes: 'All items verified',
        rejectReason: null,
        deliveryReference: 'DEL-1003',
        personnelName: 'Haseeb Ahmed',
        routeLabel: 'Lahore-Central',
        shadowStatus: 'synced',
        reviewerComment: 'Approved — all quantities match',
        proofSignedBy: 'City Supermarket Manager',
        proofVerificationMethod: 'bill_photo',
        proofBillPhotoUrl: 'https://placehold.co/400x600/png',
        proofBillPhotoCapturedAt: new Date(Date.now() - 86400000),
      }),
    );
    await m.save(
      m.create(InventoryUpdateRequestLine, {
        requestId: approvalReq1.id,
        itemId: items.length > 2 ? items[2].id : items[0].id,
        itemName: 'Rice 5kg',
        beforeQty: '100',
        deliveredQty: '8',
        returnedQty: '0',
        afterQty: '92',
      }),
    );

    // 2) DEL-1001 (in progress by Saim) — pending
    const del1001 = seededDeliveries['DEL-1001'];
    const approvalReq2 = await m.save(
      m.create(InventoryUpdateRequest, {
        companyId: company.id,
        deliveryId: del1001.id,
        personnelId: saim.id,
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
        reviewedBy: null,
        approvalNotes: null,
        rejectReason: null,
        deliveryReference: 'DEL-1001',
        personnelName: 'Saim Raza',
        routeLabel: 'Lahore-West',
        shadowStatus: 'pending',
        reviewerComment: null,
        proofSignedBy: 'Ali General Store Owner',
        proofVerificationMethod: 'bill_photo',
        proofBillPhotoUrl: 'https://placehold.co/400x600/png',
        proofBillPhotoCapturedAt: new Date(),
      }),
    );
    await m.save([
      m.create(InventoryUpdateRequestLine, {
        requestId: approvalReq2.id,
        itemId: items.length > 1 ? items[1].id : items[0].id,
        itemName: 'AquaPure 500ml',
        beforeQty: '200',
        deliveredQty: '20',
        returnedQty: '0',
        afterQty: '180',
      }),
      m.create(InventoryUpdateRequestLine, {
        requestId: approvalReq2.id,
        itemId: items.length > 4 ? items[4].id : items[0].id,
        itemName: 'Dalda Oil 1L',
        beforeQty: '50',
        deliveredQty: '10',
        returnedQty: '0',
        afterQty: '40',
      }),
    ]);
    console.log('  ✓ 2 inventory approval requests seeded (1 approved, 1 pending)');

    // =================================================================
    // DONE
    // =================================================================
    console.log('\n' + '='.repeat(60));
    console.log(`  MetroMatrix seed completed! Admin: ${ADMIN_EMAIL}`);
    console.log('='.repeat(60));
    console.log('\n  Login Credentials:');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Admin:  ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log(`  DP #1:  saim@metromatrix.com      / ${DP_PASSWORD}`);
    console.log(`  DP #2:  haseeb@metromatrix.com    / ${DP_PASSWORD}`);
    console.log(`  Company invite code: ${company.inviteCode}`);
    console.log('  ─────────────────────────────────────────────');

    // =================================================================
    // 12. TRANSACTIONS — 1 YEAR OF DATA
    // =================================================================
    const allCusts = await m.find(Customer, { where: { companyId: company.id } });
    const allVends = await m.find(Vendor, { where: { companyId: company.id } });
    const allAccounts = await m.find(Account, { where: { companyId: company.id } });
    const salesAccount = allAccounts.find(a => a.name.includes('Sales') || a.type === 'revenue') ?? allAccounts[0];
    const cashAccount = allAccounts.find(a => a.name.includes('Cash') || a.subType === 'Cash') ?? allAccounts[0];
    const arAccount = allAccounts.find(a => a.name.includes('Receivable') || a.subType === 'Accounts Receivable') ?? allAccounts[0];
    const apAccount = allAccounts.find(a => a.name.includes('Payable') || a.subType === 'Accounts Payable') ?? allAccounts[0];
    const expenseAccount = allAccounts.find(a => a.type === 'expense') ?? allAccounts[0];

    // Helper: compute line totals (quantity * unitPrice, taxed at 17%)
    const t17 = (sub: number) => +(sub * 0.17).toFixed(4);
    const lt17 = (sub: number) => +(sub * 1.17).toFixed(4);

    // ── 12a. INVOICES (20 items, 1 year May 2025–Apr 2026) ──────────────
    if (allCusts.length > 0) {
      type InvLine = { desc: string; qty: number; price: number };
      type InvDef = { num: string; c: number; status: string; date: string; due: string; paidFrac: number; lines: InvLine[] };

      const invDefs: InvDef[] = [
        { num: 'INV-2025-001', c: 0, status: 'paid',    date: '2025-06-01', due: '2025-07-01', paidFrac: 1,    lines: [{ desc: 'Habib Cooking Oil 5L', qty: 20, price: 2100 }, { desc: 'Surf Excel 1kg', qty: 30, price: 450 }] },
        { num: 'INV-2025-002', c: 1, status: 'paid',    date: '2025-06-10', due: '2025-07-10', paidFrac: 1,    lines: [{ desc: 'Sufi Cooking Oil 5L', qty: 15, price: 1980 }, { desc: 'Bonus Tristar 1kg', qty: 20, price: 340 }] },
        { num: 'INV-2025-003', c: 2, status: 'paid',    date: '2025-07-05', due: '2025-08-05', paidFrac: 1,    lines: [{ desc: 'Bonus Tristar 1kg', qty: 50, price: 340 }, { desc: 'Brite Total 1kg', qty: 25, price: 365 }] },
        { num: 'INV-2025-004', c: 3, status: 'partial', date: '2025-07-15', due: '2025-08-15', paidFrac: 0.5,  lines: [{ desc: 'Habib Cooking Oil 1L', qty: 40, price: 480 }] },
        { num: 'INV-2025-005', c: 4, status: 'paid',    date: '2025-08-02', due: '2025-09-02', paidFrac: 1,    lines: [{ desc: 'Ariel Matic 500g', qty: 100, price: 310 }, { desc: 'Lemon Max Dishwash 750ml', qty: 30, price: 220 }] },
        { num: 'INV-2025-006', c: 5, status: 'paid',    date: '2025-08-20', due: '2025-09-20', paidFrac: 1,    lines: [{ desc: 'Sufi Cooking Oil 1L', qty: 30, price: 450 }, { desc: 'Vim Dishwash Bar 500g', qty: 40, price: 150 }] },
        { num: 'INV-2025-007', c: 6, status: 'paid',    date: '2025-09-05', due: '2025-10-05', paidFrac: 1,    lines: [{ desc: 'Lemon Max Dishwash 750ml', qty: 60, price: 220 }, { desc: 'Harpic Original 500ml', qty: 20, price: 280 }] },
        { num: 'INV-2025-008', c: 7, status: 'partial', date: '2025-09-18', due: '2025-10-18', paidFrac: 0.5,  lines: [{ desc: 'Dalda Banaspati Ghee 2.5kg', qty: 20, price: 1520 }] },
        { num: 'INV-2025-009', c: 0, status: 'paid',    date: '2025-10-01', due: '2025-11-01', paidFrac: 1,    lines: [{ desc: 'Habib Cooking Oil 5L', qty: 25, price: 2100 }, { desc: 'Surf Excel 1kg', qty: 20, price: 450 }] },
        { num: 'INV-2025-010', c: 1, status: 'overdue', date: '2025-10-15', due: '2025-11-15', paidFrac: 0,    lines: [{ desc: 'Surf Excel 1kg', qty: 35, price: 450 }, { desc: 'Ariel Matic 500g', qty: 20, price: 310 }] },
        { num: 'INV-2025-011', c: 2, status: 'sent',    date: '2025-11-03', due: '2025-12-03', paidFrac: 0,    lines: [{ desc: 'Bonus Tristar 1kg', qty: 40, price: 340 }, { desc: 'Brite Total 1kg', qty: 30, price: 365 }] },
        { num: 'INV-2025-012', c: 3, status: 'paid',    date: '2025-11-20', due: '2025-12-20', paidFrac: 1,    lines: [{ desc: 'Sufi Cooking Oil 5L', qty: 15, price: 1980 }, { desc: 'Habib Cooking Oil 1L', qty: 20, price: 480 }] },
        { num: 'INV-2025-013', c: 4, status: 'partial', date: '2025-12-05', due: '2026-01-05', paidFrac: 0.5,  lines: [{ desc: 'Ariel Matic 500g', qty: 80, price: 310 }, { desc: 'Lemon Max Dishwash 750ml', qty: 20, price: 220 }] },
        { num: 'INV-2025-014', c: 5, status: 'void',    date: '2025-12-18', due: '2026-01-18', paidFrac: 0,    lines: [{ desc: 'Habib Cooking Oil 5L', qty: 20, price: 2100 }] },
        { num: 'INV-2026-001', c: 6, status: 'paid',    date: '2026-01-08', due: '2026-02-08', paidFrac: 1,    lines: [{ desc: 'Surf Excel 1kg', qty: 50, price: 450 }, { desc: 'Brite Total 1kg', qty: 30, price: 365 }] },
        { num: 'INV-2026-002', c: 7, status: 'overdue', date: '2026-01-22', due: '2026-02-22', paidFrac: 0,    lines: [{ desc: 'Habib Cooking Oil 5L', qty: 30, price: 2100 }] },
        { num: 'INV-2026-003', c: 0, status: 'sent',    date: '2026-02-10', due: '2026-03-10', paidFrac: 0,    lines: [{ desc: 'Sufi Cooking Oil 1L', qty: 40, price: 450 }, { desc: 'Harpic Original 500ml', qty: 25, price: 280 }] },
        { num: 'INV-2026-004', c: 1, status: 'draft',   date: '2026-02-25', due: '2026-03-25', paidFrac: 0,    lines: [{ desc: 'Dalda Banaspati Ghee 2.5kg', qty: 15, price: 1520 }] },
        { num: 'INV-2026-005', c: 2, status: 'overdue', date: '2026-03-05', due: '2026-04-05', paidFrac: 0,    lines: [{ desc: 'Harpic Original 500ml', qty: 60, price: 280 }, { desc: 'Vim Dishwash Bar 500g', qty: 40, price: 150 }] },
        { num: 'INV-2026-006', c: 3, status: 'partial', date: '2026-04-01', due: '2026-05-01', paidFrac: 0.5,  lines: [{ desc: 'Bonus Tristar 1kg', qty: 50, price: 340 }, { desc: 'Surf Excel 1kg', qty: 35, price: 450 }] },
      ];

      for (const def of invDefs) {
        const sub = def.lines.reduce((s, l) => s + l.qty * l.price, 0);
        const tax = t17(sub);
        const tot = sub + tax;
        const paid = +(tot * def.paidFrac).toFixed(4);
        const bal = +(tot - paid).toFixed(4);
        const invoice = await m.save(m.create(Invoice, {
          companyId: company.id,
          customerId: allCusts[def.c % allCusts.length].id,
          invoiceNumber: def.num,
          invoiceDate: def.date,
          dueDate: def.due,
          subtotal: String(sub),
          discountType: 'none',
          discountValue: '0',
          discountAmount: '0',
          taxAmount: String(tax),
          total: String(tot),
          amountPaid: String(paid),
          balance: String(bal),
          status: def.status as any,
          notes: `Invoice for ${allCusts[def.c % allCusts.length].name}`,
          paymentTerms: 'net30',
          createdBy: admin.id,
        }));
        for (let i = 0; i < def.lines.length; i++) {
          const l = def.lines[i];
          const lineSub = l.qty * l.price;
          await m.save(m.create(InvoiceLineItem, {
            invoiceId: invoice.id,
            description: l.desc,
            quantity: String(l.qty),
            unitPrice: String(l.price),
            taxRate: '17',
            taxAmount: String(t17(lineSub)),
            lineTotal: String(lt17(lineSub)),
            accountId: salesAccount?.id ?? null,
            lineOrder: i,
          }));
        }
      }
      console.log('  ✓ 20 invoices with line items created (1 year, all statuses)');
    }

    // ── 12b. BILLS (15 items, 1 year May 2025–Apr 2026) ─────────────────
    if (allVends.length > 0) {
      type BillLine = { desc: string; amount: number };
      type BillDef = { num: string; v: number; status: string; date: string; due: string; paidFrac: number; lines: BillLine[] };

      const billDefs: BillDef[] = [
        { num: 'BILL-2025-001', v: 0, status: 'paid',    date: '2025-06-03', due: '2025-07-03', paidFrac: 1,    lines: [{ desc: 'Habib Cooking Oil 5L bulk purchase', amount: 92500 }, { desc: 'Habib Cooking Oil 1L bulk purchase', amount: 50400 }] },
        { num: 'BILL-2025-002', v: 1, status: 'paid',    date: '2025-06-15', due: '2025-07-15', paidFrac: 1,    lines: [{ desc: 'Surf Excel 1kg — 500 units', amount: 190000 }, { desc: 'Bonus Tristar 1kg — 600 units', amount: 174000 }] },
        { num: 'BILL-2025-003', v: 2, status: 'paid',    date: '2025-07-08', due: '2025-08-08', paidFrac: 1,    lines: [{ desc: 'Sufi Cooking Oil 5L bulk', amount: 665000 }] },
        { num: 'BILL-2025-004', v: 3, status: 'paid',    date: '2025-07-22', due: '2025-08-22', paidFrac: 1,    lines: [{ desc: 'Lemon Max Dishwash 750ml — 400 units', amount: 72000 }, { desc: 'Vim Dishwash Bar 500g — 300 units', amount: 36000 }] },
        { num: 'BILL-2025-005', v: 4, status: 'paid',    date: '2025-08-05', due: '2025-09-05', paidFrac: 1,    lines: [{ desc: 'Packaging materials — August batch', amount: 45000 }] },
        { num: 'BILL-2025-006', v: 0, status: 'paid',    date: '2025-09-10', due: '2025-10-10', paidFrac: 1,    lines: [{ desc: 'Habib Cooking Oil 5L bulk purchase', amount: 110500 }] },
        { num: 'BILL-2025-007', v: 1, status: 'paid',    date: '2025-10-01', due: '2025-11-01', paidFrac: 1,    lines: [{ desc: 'Ariel Matic 500g — 800 units', amount: 208000 }, { desc: 'Brite Total 1kg — 400 units', amount: 124000 }] },
        { num: 'BILL-2025-008', v: 2, status: 'partial', date: '2025-10-18', due: '2025-11-18', paidFrac: 0.5,  lines: [{ desc: 'Sufi Cooking Oil 1L bulk', amount: 380000 }] },
        { num: 'BILL-2025-009', v: 3, status: 'open',    date: '2025-11-05', due: '2025-12-05', paidFrac: 0,    lines: [{ desc: 'Harpic Original 500ml — 300 units', amount: 69000 }] },
        { num: 'BILL-2025-010', v: 4, status: 'open',    date: '2025-11-20', due: '2025-12-20', paidFrac: 0,    lines: [{ desc: 'Packaging materials — Nov batch', amount: 48000 }] },
        { num: 'BILL-2025-011', v: 0, status: 'paid',    date: '2025-12-08', due: '2026-01-08', paidFrac: 1,    lines: [{ desc: 'Habib Oil year-end stock', amount: 185000 }, { desc: 'Dalda Banaspati Ghee 2.5kg', amount: 120000 }] },
        { num: 'BILL-2026-001', v: 1, status: 'open',    date: '2026-01-10', due: '2026-02-10', paidFrac: 0,    lines: [{ desc: 'Detergent Q1 purchase order', amount: 210000 }] },
        { num: 'BILL-2026-002', v: 2, status: 'partial', date: '2026-02-01', due: '2026-03-01', paidFrac: 0.4,  lines: [{ desc: 'Sufi Oil Feb replenishment', amount: 450000 }] },
        { num: 'BILL-2026-003', v: 3, status: 'open',    date: '2026-03-05', due: '2026-04-05', paidFrac: 0,    lines: [{ desc: 'Cleaning products Q1', amount: 95000 }] },
        { num: 'BILL-2026-004', v: 0, status: 'draft',   date: '2026-04-15', due: '2026-05-15', paidFrac: 0,    lines: [{ desc: 'Habib Oil Apr order (draft)', amount: 125000 }] },
      ];

      for (const def of billDefs) {
        const sub = def.lines.reduce((s, l) => s + l.amount, 0);
        const tax = t17(sub);
        const tot = sub + tax;
        const paid = +(tot * def.paidFrac).toFixed(4);
        const bal = +(tot - paid).toFixed(4);
        const bill = await m.save(m.create(Bill, {
          companyId: company.id,
          vendorId: allVends[def.v % allVends.length].id,
          billNumber: def.num,
          billDate: def.date,
          dueDate: def.due,
          subtotal: String(sub),
          taxAmount: String(tax),
          total: String(tot),
          amountPaid: String(paid),
          balance: String(bal),
          status: def.status as any,
          memo: `Purchase from ${allVends[def.v % allVends.length].companyName}`,
          createdBy: admin.id,
        } as any));
        for (let i = 0; i < def.lines.length; i++) {
          const l = def.lines[i];
          await m.save(m.create(BillLineItem, {
            billId: bill.id,
            accountId: expenseAccount?.id ?? null,
            description: l.desc,
            amount: String(l.amount),
            taxRate: '17',
            lineOrder: i,
          } as any));
        }
      }
      console.log('  ✓ 15 bills with line items created (1 year, all statuses)');
    }

    // ── 12c. JOURNAL ENTRIES (15 items, 1 year) ──────────────────────────
    {
      const jeData = [
        { ref: 'JE-2025-001', date: '2025-05-01', memo: 'Opening balances — FY 2025-26',          status: 'posted', amt: 2500000 },
        { ref: 'JE-2025-002', date: '2025-06-30', memo: 'Monthly rent — June 2025',                status: 'posted', amt: 55000 },
        { ref: 'JE-2025-003', date: '2025-06-30', memo: 'Utility bills — June 2025',               status: 'posted', amt: 14500 },
        { ref: 'JE-2025-004', date: '2025-07-31', memo: 'Monthly rent — July 2025',                status: 'posted', amt: 55000 },
        { ref: 'JE-2025-005', date: '2025-07-31', memo: 'Salary disbursement — July 2025',         status: 'posted', amt: 270000 },
        { ref: 'JE-2025-006', date: '2025-08-31', memo: 'Monthly rent — August 2025',              status: 'posted', amt: 55000 },
        { ref: 'JE-2025-007', date: '2025-09-30', memo: 'Depreciation — Q1 FY 2025-26',            status: 'posted', amt: 25000 },
        { ref: 'JE-2025-008', date: '2025-10-31', memo: 'Salary disbursement — October 2025',      status: 'posted', amt: 270000 },
        { ref: 'JE-2025-009', date: '2025-11-30', memo: 'Monthly rent — November 2025',            status: 'posted', amt: 55000 },
        { ref: 'JE-2025-010', date: '2025-12-31', memo: 'Year-end inventory adjustment',           status: 'posted', amt: 48000 },
        { ref: 'JE-2026-001', date: '2026-01-31', memo: 'Salary disbursement — January 2026',      status: 'posted', amt: 270000 },
        { ref: 'JE-2026-002', date: '2026-02-28', memo: 'Monthly rent — February 2026',            status: 'posted', amt: 55000 },
        { ref: 'JE-2026-003', date: '2026-03-31', memo: 'Depreciation — Q3 FY 2025-26',            status: 'posted', amt: 25000 },
        { ref: 'JE-2026-004', date: '2026-04-15', memo: 'Salary disbursement — April 2026',        status: 'posted', amt: 270000 },
        { ref: 'JE-2026-005', date: '2026-04-30', memo: 'Prepaid insurance adjustment (draft)',    status: 'draft',  amt: 36000 },
      ];
      for (const je of jeData) {
        const entry = await m.save(m.create(JournalEntry, {
          companyId: company.id,
          reference: je.ref,
          date: je.date,
          memo: je.memo,
          status: je.status as any,
          totalDebits: String(je.amt),
          totalCredits: String(je.amt),
          createdBy: admin.id,
          postedBy: je.status === 'posted' ? admin.id : null,
          postedAt: je.status === 'posted' ? new Date() : null,
        }));
        await m.save(m.create(JournalEntryLine, {
          entryId: entry.id,
          accountId: expenseAccount?.id ?? allAccounts[0].id,
          description: je.memo + ' — debit',
          debit: String(je.amt),
          credit: '0',
          lineOrder: 0,
        }));
        await m.save(m.create(JournalEntryLine, {
          entryId: entry.id,
          accountId: cashAccount?.id ?? allAccounts[1]?.id ?? allAccounts[0].id,
          description: je.memo + ' — credit',
          debit: '0',
          credit: String(je.amt),
          lineOrder: 1,
        }));
      }
      console.log('  ✓ 15 journal entries created (14 posted, 1 draft)');
    }

    // ── 12d. BANK ACCOUNTS + TRANSACTIONS (1 year) ──────────────────────
    {
      const checking = await m.save(m.create(BankAccount, {
        companyId: company.id,
        name: 'MCB Business Current Account',
        bankName: 'MCB Bank',
        accountNumber: '0012-3456789-001',
        accountType: 'checking',
        balance: '4850000',
        linkedAccountId: cashAccount?.id ?? allAccounts[0].id,
        lastReconciled: null,
        isActive: true,
      }));
      await m.save(m.create(BankAccount, {
        companyId: company.id,
        name: 'HBL Business Savings',
        bankName: 'Habib Bank Limited',
        accountNumber: '9876-5432100-002',
        accountType: 'savings',
        balance: '8500000',
        linkedAccountId: allAccounts.length > 1 ? allAccounts[1].id : allAccounts[0].id,
        lastReconciled: null,
        isActive: true,
      }));

      const txns = [
        // FY 2025 — June
        { date: '2025-06-05', type: 'deposit', payee: 'Tariq General Store', ref: 'PMT-2025-001', amount: 64935, memo: 'INV-2025-001 payment' },
        { date: '2025-06-15', type: 'deposit', payee: 'Al-Madina Mart', ref: 'PMT-2025-002', amount: 34749, memo: 'INV-2025-002 payment' },
        { date: '2025-06-20', type: 'expense', payee: 'Habib Oil Mills', ref: 'CHK-2025-001', amount: 108225, memo: 'BILL-2025-001 payment' },
        { date: '2025-06-30', type: 'expense', payee: 'Office Rent June', ref: 'CHK-2025-002', amount: 55000, memo: 'Monthly rent' },
        // July
        { date: '2025-07-10', type: 'deposit', payee: 'Iqbal Grocery', ref: 'PMT-2025-003', amount: 30566, memo: 'INV-2025-003 payment' },
        { date: '2025-07-15', type: 'expense', payee: 'Pak Detergent Industries', ref: 'CHK-2025-003', amount: 426786, memo: 'BILL-2025-002 payment' },
        { date: '2025-07-31', type: 'expense', payee: 'Payroll July', ref: 'SAL-2025-001', amount: 270000, memo: 'Staff salaries July' },
        // August
        { date: '2025-08-10', type: 'deposit', payee: 'City Wholesale', ref: 'PMT-2025-004', amount: 36270, memo: 'INV-2025-005 payment' },
        { date: '2025-08-12', type: 'deposit', payee: 'Bismillah Trading', ref: 'PMT-2025-005', amount: 15795, memo: 'INV-2025-006 payment' },
        { date: '2025-08-15', type: 'expense', payee: 'Sufi Cooking Oil', ref: 'CHK-2025-004', amount: 777555, memo: 'BILL-2025-003 payment' },
        { date: '2025-08-31', type: 'expense', payee: 'Office Rent August', ref: 'CHK-2025-005', amount: 55000, memo: 'Monthly rent' },
        // September
        { date: '2025-09-05', type: 'deposit', payee: 'Noor Enterprises', ref: 'PMT-2025-006', amount: 22464, memo: 'INV-2025-007 payment' },
        { date: '2025-09-12', type: 'expense', payee: 'Bright Chemical Works', ref: 'CHK-2025-006', amount: 124380, memo: 'BILL-2025-004 payment' },
        { date: '2025-09-30', type: 'expense', payee: 'Payroll September', ref: 'SAL-2025-002', amount: 270000, memo: 'Staff salaries Sept' },
        // October
        { date: '2025-10-08', type: 'deposit', payee: 'Tariq General Store', ref: 'PMT-2025-007', amount: 61425, memo: 'INV-2025-009 payment' },
        { date: '2025-10-15', type: 'expense', payee: 'K-Electric', ref: 'CHK-2025-007', amount: 18500, memo: 'Electricity bill Oct' },
        // November
        { date: '2025-11-01', type: 'deposit', payee: 'Punjab Mart', ref: 'PMT-2025-008', amount: 17784, memo: 'INV-2025-008 partial' },
        { date: '2025-11-28', type: 'deposit', payee: 'Rehman Superstore', ref: 'PMT-2025-009', amount: 45981, memo: 'INV-2025-012 payment' },
        { date: '2025-11-30', type: 'expense', payee: 'Payroll November', ref: 'SAL-2025-003', amount: 270000, memo: 'Staff salaries Nov' },
        // December
        { date: '2025-12-10', type: 'deposit', payee: 'City Wholesale', ref: 'PMT-2025-010', amount: 14508, memo: 'INV-2025-013 partial' },
        { date: '2025-12-20', type: 'expense', payee: 'Office Rent December', ref: 'CHK-2025-008', amount: 55000, memo: 'Monthly rent' },
        { date: '2025-12-31', type: 'transfer', payee: 'HBL Business Savings', ref: 'TRF-2025-001', amount: 500000, memo: 'Year-end savings transfer' },
        // 2026 — January
        { date: '2026-01-10', type: 'deposit', payee: 'Noor Enterprises', ref: 'PMT-2026-001', amount: 39137, memo: 'INV-2026-001 payment' },
        { date: '2026-01-31', type: 'expense', payee: 'Payroll January', ref: 'SAL-2026-001', amount: 270000, memo: 'Staff salaries Jan' },
        // February
        { date: '2026-02-15', type: 'expense', payee: 'K-Electric', ref: 'CHK-2026-001', amount: 21000, memo: 'Electricity bill Feb' },
        { date: '2026-02-28', type: 'expense', payee: 'Office Rent February', ref: 'CHK-2026-002', amount: 55000, memo: 'Monthly rent' },
        // March
        { date: '2026-03-15', type: 'expense', payee: 'Payroll March', ref: 'SAL-2026-002', amount: 270000, memo: 'Staff salaries Mar' },
        // April
        { date: '2026-04-10', type: 'deposit', payee: 'Rehman Superstore', ref: 'PMT-2026-002', amount: 19159, memo: 'INV-2026-006 partial' },
        { date: '2026-04-28', type: 'expense', payee: 'Office Rent April', ref: 'CHK-2026-003', amount: 55000, memo: 'Monthly rent' },
        { date: '2026-04-30', type: 'expense', payee: 'Payroll April', ref: 'SAL-2026-003', amount: 270000, memo: 'Staff salaries Apr' },
      ];

      let runBal = 4850000;
      for (const tx of txns) {
        if (tx.type === 'deposit') runBal += tx.amount;
        else runBal -= tx.amount;
        await m.save(m.create(BankTransaction, {
          companyId: company.id,
          bankAccountId: checking.id,
          date: tx.date,
          type: tx.type as any,
          payee: tx.payee,
          reference: tx.ref,
          amount: String(tx.amount),
          balance: String(runBal),
          accountId: tx.type === 'deposit' ? (arAccount?.id ?? null) : (expenseAccount?.id ?? null),
          memo: tx.memo,
          isCleared: true,
          clearedDate: new Date(),
        }));
      }
      console.log('  ✓ 2 bank accounts + 30 transactions created (1 year)');
    }

    // =================================================================
    // 16. TAX RATES
    // =================================================================
    const taxCount = await m.countBy(TaxRate, { companyId: company.id });
    if (taxCount === 0) {
      await m.save([
        m.create(TaxRate, { companyId: company.id, name: 'GST (17%)', rate: '17', type: 'sales' as any, authority: 'FBR', isActive: true, isDefault: true }),
        m.create(TaxRate, { companyId: company.id, name: 'Withholding Tax (4.5%)', rate: '4.5', type: 'income' as any, authority: 'FBR', isActive: true, isDefault: false }),
        m.create(TaxRate, { companyId: company.id, name: 'Excise Duty (5%)', rate: '5', type: 'sales' as any, authority: 'Provincial', isActive: true, isDefault: false }),
        m.create(TaxRate, { companyId: company.id, name: 'Zero-rated (Export)', rate: '0', type: 'sales' as any, authority: 'FBR', isActive: true, isDefault: false }),
      ]);
      console.log('  ✓ 4 tax rates created (GST, WHT, Excise, Zero-rated)');
    }

    // =================================================================
    // 17. SALES ORDERS, PURCHASE ORDERS, BUDGETS, PAYROLL
    // =================================================================
    // Sales Orders — 10, full year with SalesOrderLine items
    if (allCusts.length > 0) {
      type SOLine = { itemIdx: number | null; desc: string; ordQty: number; fulQty: number; price: number };
      type SODef = { num: string; c: number; status: string; orderDate: string; expectedDate: string; notes: string; lines: SOLine[] };

      const soDefs: SODef[] = [
        { num: 'SO-2025-001', c: 0, status: 'fulfilled', orderDate: '2025-06-02', expectedDate: '2025-06-15', notes: 'Habib oils June bulk', lines: [
          { itemIdx: 0, desc: 'Habib Cooking Oil 5L', ordQty: 20, fulQty: 20, price: 2100 },
          { itemIdx: 5, desc: 'Surf Excel 1kg', ordQty: 30, fulQty: 30, price: 450 },
        ]},
        { num: 'SO-2025-002', c: 1, status: 'fulfilled', orderDate: '2025-06-10', expectedDate: '2025-06-25', notes: 'Al-Madina Mart June', lines: [
          { itemIdx: 2, desc: 'Sufi Cooking Oil 5L', ordQty: 15, fulQty: 15, price: 1980 },
          { itemIdx: 6, desc: 'Bonus Tristar 1kg', ordQty: 20, fulQty: 20, price: 340 },
        ]},
        { num: 'SO-2025-003', c: 2, status: 'confirmed', orderDate: '2025-07-05', expectedDate: '2025-07-20', notes: 'Detergent order July', lines: [
          { itemIdx: 6, desc: 'Bonus Tristar 1kg', ordQty: 50, fulQty: 0, price: 340 },
          { itemIdx: 7, desc: 'Brite Total 1kg', ordQty: 25, fulQty: 0, price: 365 },
        ]},
        { num: 'SO-2025-004', c: 3, status: 'fulfilled', orderDate: '2025-08-01', expectedDate: '2025-08-15', notes: 'August cooking oil restock', lines: [
          { itemIdx: 1, desc: 'Habib Cooking Oil 1L', ordQty: 40, fulQty: 40, price: 480 },
        ]},
        { num: 'SO-2025-005', c: 4, status: 'open', orderDate: '2025-09-10', expectedDate: '2025-09-25', notes: 'City Wholesale weekly supply', lines: [
          { itemIdx: 8, desc: 'Ariel Matic 500g', ordQty: 100, fulQty: 0, price: 310 },
          { itemIdx: 9, desc: 'Lemon Max Dishwash 750ml', ordQty: 30, fulQty: 0, price: 220 },
        ]},
        { num: 'SO-2025-006', c: 5, status: 'fulfilled', orderDate: '2025-10-05', expectedDate: '2025-10-20', notes: 'Bismillah October order', lines: [
          { itemIdx: 3, desc: 'Sufi Cooking Oil 1L', ordQty: 30, fulQty: 30, price: 450 },
          { itemIdx: 10, desc: 'Vim Dishwash Bar 500g', ordQty: 40, fulQty: 40, price: 150 },
        ]},
        { num: 'SO-2025-007', c: 6, status: 'draft', orderDate: '2025-11-01', expectedDate: '2025-11-20', notes: 'Noor Enterprises Q3 draft', lines: [
          { itemIdx: 9, desc: 'Lemon Max Dishwash 750ml', ordQty: 60, fulQty: 0, price: 220 },
          { itemIdx: 11, desc: 'Harpic Original 500ml', ordQty: 20, fulQty: 0, price: 280 },
        ]},
        { num: 'SO-2026-001', c: 7, status: 'open', orderDate: '2026-01-08', expectedDate: '2026-01-25', notes: 'Punjab Mart January supply', lines: [
          { itemIdx: 5, desc: 'Surf Excel 1kg', ordQty: 50, fulQty: 0, price: 450 },
          { itemIdx: 7, desc: 'Brite Total 1kg', ordQty: 30, fulQty: 0, price: 365 },
        ]},
        { num: 'SO-2026-002', c: 0, status: 'confirmed', orderDate: '2026-02-10', expectedDate: '2026-02-28', notes: 'Tariq Q4 order', lines: [
          { itemIdx: 0, desc: 'Habib Cooking Oil 5L', ordQty: 30, fulQty: 0, price: 2100 },
        ]},
        { num: 'SO-2026-003', c: 1, status: 'draft', orderDate: '2026-03-05', expectedDate: '2026-03-25', notes: 'Al-Madina March draft', lines: [
          { itemIdx: 4, desc: 'Dalda Banaspati Ghee 2.5kg', ordQty: 15, fulQty: 0, price: 1520 },
        ]},
      ];

      for (const def of soDefs) {
        const sub = def.lines.reduce((s, l) => s + l.ordQty * l.price, 0);
        const tax = t17(sub);
        const tot = sub + tax;
        const so = await m.save(m.create(SalesOrder, {
          companyId: company.id,
          customerId: allCusts[def.c % allCusts.length].id,
          orderNumber: def.num,
          orderDate: def.orderDate,
          expectedDate: def.expectedDate,
          subtotal: String(sub),
          taxAmount: String(tax),
          total: String(tot),
          status: def.status as any,
          notes: def.notes,
        } as any));
        for (let i = 0; i < def.lines.length; i++) {
          const l = def.lines[i];
          const lineSub = l.ordQty * l.price;
          await m.save(m.create(SalesOrderLine, {
            orderId: so.id,
            itemId: l.itemIdx !== null && items.length > l.itemIdx ? items[l.itemIdx].id : null,
            description: l.desc,
            orderedQty: String(l.ordQty),
            fulfilledQty: String(l.fulQty),
            unitPrice: String(l.price),
            taxRate: '17',
            lineTotal: String(lt17(lineSub)),
            lineOrder: i,
          } as any));
        }
      }
      console.log('  ✓ 10 sales orders with line items created (full year)');
    }

    // Purchase Orders — 6, full year with PurchaseOrderLine items
    if (allVends.length > 0) {
      type POLine = { itemIdx: number | null; desc: string; ordQty: number; recQty: number; cost: number };
      type PODef = { num: string; v: number; status: string; orderDate: string; expectedDate: string; notes: string; lines: POLine[] };

      const poDefs: PODef[] = [
        { num: 'PO-2025-001', v: 0, status: 'received', orderDate: '2025-06-01', expectedDate: '2025-06-10', notes: 'Habib Oil June restock', lines: [
          { itemIdx: 0, desc: 'Habib Cooking Oil 5L — 50 units', ordQty: 50, recQty: 50, cost: 1850 },
          { itemIdx: 1, desc: 'Habib Cooking Oil 1L — 120 units', ordQty: 120, recQty: 120, cost: 420 },
        ]},
        { num: 'PO-2025-002', v: 1, status: 'received', orderDate: '2025-07-05', expectedDate: '2025-07-15', notes: 'Detergent July bulk purchase', lines: [
          { itemIdx: 5, desc: 'Surf Excel 1kg — 500 units', ordQty: 500, recQty: 500, cost: 380 },
          { itemIdx: 6, desc: 'Bonus Tristar 1kg — 600 units', ordQty: 600, recQty: 600, cost: 290 },
        ]},
        { num: 'PO-2025-003', v: 2, status: 'partial', orderDate: '2025-09-01', expectedDate: '2025-09-15', notes: 'Sufi Oil Sep replenishment', lines: [
          { itemIdx: 2, desc: 'Sufi Cooking Oil 5L — 200 units', ordQty: 200, recQty: 100, cost: 1750 },
          { itemIdx: 3, desc: 'Sufi Cooking Oil 1L — 500 units', ordQty: 500, recQty: 250, cost: 400 },
        ]},
        { num: 'PO-2025-004', v: 3, status: 'received', orderDate: '2025-11-03', expectedDate: '2025-11-15', notes: 'Cleaners Q4 restock', lines: [
          { itemIdx: 9, desc: 'Lemon Max Dishwash 750ml — 400 units', ordQty: 400, recQty: 400, cost: 180 },
          { itemIdx: 10, desc: 'Vim Dishwash Bar 500g — 300 units', ordQty: 300, recQty: 300, cost: 120 },
          { itemIdx: 11, desc: 'Harpic Original 500ml — 300 units', ordQty: 300, recQty: 300, cost: 230 },
        ]},
        { num: 'PO-2026-001', v: 0, status: 'sent', orderDate: '2026-02-01', expectedDate: '2026-02-15', notes: 'Habib Oil Feb order', lines: [
          { itemIdx: 0, desc: 'Habib Cooking Oil 5L — 60 units', ordQty: 60, recQty: 0, cost: 1850 },
          { itemIdx: 4, desc: 'Dalda Banaspati Ghee 2.5kg — 40 units', ordQty: 40, recQty: 0, cost: 1350 },
        ]},
        { num: 'PO-2026-002', v: 1, status: 'draft', orderDate: '2026-04-10', expectedDate: '2026-04-30', notes: 'Q2 detergent draft order', lines: [
          { itemIdx: 7, desc: 'Brite Total 1kg — 400 units', ordQty: 400, recQty: 0, cost: 310 },
          { itemIdx: 8, desc: 'Ariel Matic 500g — 300 units', ordQty: 300, recQty: 0, cost: 260 },
        ]},
      ];

      for (const def of poDefs) {
        const sub = def.lines.reduce((s, l) => s + l.ordQty * l.cost, 0);
        const tax = t17(sub);
        const tot = sub + tax;
        const po = await m.save(m.create(PurchaseOrder, {
          companyId: company.id,
          vendorId: allVends[def.v % allVends.length].id,
          poNumber: def.num,
          orderDate: def.orderDate,
          expectedDate: def.expectedDate,
          subtotal: String(sub),
          taxAmount: String(tax),
          total: String(tot),
          status: def.status as any,
          notes: def.notes,
        } as any));
        for (let i = 0; i < def.lines.length; i++) {
          const l = def.lines[i];
          const lineSub = l.ordQty * l.cost;
          await m.save(m.create(PurchaseOrderLine, {
            orderId: po.id,
            itemId: l.itemIdx !== null && items.length > l.itemIdx ? items[l.itemIdx].id : null,
            description: l.desc,
            orderedQty: String(l.ordQty),
            receivedQty: String(l.recQty),
            unitCost: String(l.cost),
            taxRate: '17',
            lineTotal: String(lt17(lineSub)),
            accountId: expenseAccount?.id ?? null,
            lineOrder: i,
          } as any));
        }
      }
      console.log('  ✓ 6 purchase orders with line items created (full year)');
    }

    const budgetCount = await m.countBy(Budget, { companyId: company.id });
    if (budgetCount === 0) {
      await m.save(m.create(Budget, {
        companyId: company.id,
        name: 'Annual Operations 2026',
        fiscalYear: 2026,
        status: 'active',
        createdBy: admin.id,
      } as any));
      console.log('  ✓ 1 budget created');
    }

    const empCount = await m.countBy(Employee, { companyId: company.id });
    if (empCount < 3) {
      const empData = [
        { firstName: 'Ahmad', lastName: 'Khan', email: 'ahmad.khan@metromatrix.com', phone: '+92-300-1110001', department: 'Operations', jobTitle: 'Operations Manager', salary: '120000.00', hireDate: new Date('2024-06-01') },
        { firstName: 'Fatima', lastName: 'Noor', email: 'fatima.noor@metromatrix.com', phone: '+92-300-1110002', department: 'Accounting', jobTitle: 'Accountant', salary: '85000.00', hireDate: new Date('2024-08-15') },
        { firstName: 'Usman', lastName: 'Ali', email: 'usman.ali@metromatrix.com', phone: '+92-300-1110003', department: 'Warehouse', jobTitle: 'Warehouse Supervisor', salary: '65000.00', hireDate: new Date('2025-01-10') },
      ];
      for (const e of empData) {
        const exists = await m.findOne(Employee, { where: { companyId: company.id, email: e.email } as any });
        if (!exists) {
          await m.save(m.create(Employee, { companyId: company.id, ...e, employmentType: 'full_time', status: 'active' } as any));
        }
      }
      console.log('  ✓ 3 employees ensured');

      await m.save(m.create(PayrollRun, {
        companyId: company.id,
        payPeriod: 'April 2026',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        payDate: new Date('2026-04-30'),
        status: 'draft',
        totalGross: '270000.00',
        totalDeductions: '40500.00',
        totalNet: '229500.00',
        createdBy: admin.id,
      } as any));
      console.log('  ✓ 1 payroll run created');
    }

    // =================================================================
    // 18. ESTIMATES (4 estimates with line items — all statuses)
    // =================================================================
    const estimateCount = await m.countBy(Estimate, { companyId: company.id });
    if (estimateCount === 0 && allCusts.length > 0) {
      const estimateData = [
        {
          num: 'EST-2026-001', cust: 0, status: 'sent' as const,
          estimateDate: '2026-03-15', expirationDate: '2026-04-15',
          subtotal: '55500.0000', taxAmount: '9435.0000', total: '64935.0000',
          discountAmount: '0.0000', notes: 'FMCG bulk order for Q2 replenishment',
          lines: [
            { description: 'Habib Cooking Oil 5L', quantity: '20', unitPrice: '2100', taxRate: '17', lineTotal: '49140.0000', lineOrder: 0 },
            { description: 'Surf Excel 1kg', quantity: '30', unitPrice: '450', taxRate: '17', lineTotal: '15795.0000', lineOrder: 1 },
          ],
        },
        {
          num: 'EST-2026-002', cust: 1, status: 'accepted' as const,
          estimateDate: '2026-03-20', expirationDate: '2026-04-20',
          subtotal: '29700.0000', taxAmount: '5049.0000', total: '34749.0000',
          discountAmount: '0.0000', notes: 'Cooking oil restocking — accepted by customer',
          lines: [
            { description: 'Sufi Cooking Oil 5L', quantity: '15', unitPrice: '1980', taxRate: '17', lineTotal: '34749.0000', lineOrder: 0 },
          ],
        },
        {
          num: 'EST-2026-003', cust: 3, status: 'draft' as const,
          estimateDate: '2026-04-01', expirationDate: '2026-05-01',
          subtotal: '27950.0000', taxAmount: '4751.5000', total: '32701.5000',
          discountAmount: '0.0000', notes: 'Detergent assortment — pending review',
          lines: [
            { description: 'Bonus Tristar 1kg', quantity: '50', unitPrice: '340', taxRate: '17', lineTotal: '19890.0000', lineOrder: 0 },
            { description: 'Brite Total 1kg', quantity: '30', unitPrice: '365', taxRate: '17', lineTotal: '12811.5000', lineOrder: 1 },
          ],
        },
        {
          num: 'EST-2026-004', cust: 4, status: 'expired' as const,
          estimateDate: '2026-02-01', expirationDate: '2026-03-01',
          subtotal: '5500.0000', taxAmount: '935.0000', total: '6435.0000',
          discountAmount: '0.0000', notes: 'Small order — estimate expired',
          lines: [
            { description: 'Lemon Max Dishwash 750ml', quantity: '25', unitPrice: '220', taxRate: '17', lineTotal: '6435.0000', lineOrder: 0 },
          ],
        },
      ];

      for (const ed of estimateData) {
        const estimate = await m.save(m.create(Estimate, {
          companyId: company.id,
          customerId: allCusts[ed.cust].id,
          estimateNumber: ed.num,
          estimateDate: ed.estimateDate,
          expirationDate: ed.expirationDate,
          subtotal: ed.subtotal,
          discountAmount: ed.discountAmount,
          taxAmount: ed.taxAmount,
          total: ed.total,
          status: ed.status,
          convertedToInvoiceId: null,
          notes: ed.notes,
        }));
        for (const l of ed.lines) {
          await m.save(m.create(EstimateLineItem, {
            estimateId: estimate.id,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            lineTotal: l.lineTotal,
            lineOrder: l.lineOrder,
          }));
        }
      }
      console.log('  ✓ 4 estimates created (sent, accepted, draft, expired)');
    }

    // =================================================================
    // 19. CREDIT MEMOS (3 credit memos for returns / adjustments)
    // =================================================================
    const creditMemoCount = await m.countBy(CreditMemo, { companyId: company.id });
    if (creditMemoCount === 0 && allCusts.length > 0) {
      // Fetch the invoices we seeded to link originalInvoiceId
      const allInvoices = await m.find(Invoice, { where: { companyId: company.id } });
      const inv001 = allInvoices.find(i => i.invoiceNumber === 'INV-2025-001') ?? null;
      const inv003 = allInvoices.find(i => i.invoiceNumber === 'INV-2025-003') ?? null;

      const creditMemoData = [
        {
          cust: 0, date: '2026-04-20', originalInvoice: inv001,
          reason: 'Defective goods returned — 5 bottles Habib Cooking Oil 5L',
          subtotal: '10500.0000', taxAmount: '1785.0000', total: '12285.0000',
          amountApplied: '12285.0000', balance: '0.0000', status: 'applied',
          lines: [
            { description: 'Habib Cooking Oil 5L — return (defective)', quantity: '5', unitPrice: '2100', taxRate: '17', lineTotal: '12285.0000', lineOrder: 0 },
          ],
        },
        {
          cust: 2, date: '2026-04-25', originalInvoice: inv003,
          reason: 'Price adjustment — overcharged on detergent order',
          subtotal: '4500.0000', taxAmount: '765.0000', total: '5265.0000',
          amountApplied: '0.0000', balance: '5265.0000', status: 'open',
          lines: [
            { description: 'Surf Excel 1kg — price correction', quantity: '10', unitPrice: '450', taxRate: '17', lineTotal: '5265.0000', lineOrder: 0 },
          ],
        },
        {
          cust: 5, date: '2026-05-01', originalInvoice: null,
          reason: 'Returned expired stock — Brite Total 1kg',
          subtotal: '3650.0000', taxAmount: '620.5000', total: '4270.5000',
          amountApplied: '0.0000', balance: '4270.5000', status: 'open',
          lines: [
            { description: 'Brite Total 1kg — expired stock return', quantity: '10', unitPrice: '365', taxRate: '17', lineTotal: '4270.5000', lineOrder: 0 },
          ],
        },
      ];

      for (const cd of creditMemoData) {
        const cm = await m.save(m.create(CreditMemo, {
          companyId: company.id,
          customerId: allCusts[cd.cust].id,
          date: cd.date,
          originalInvoiceId: cd.originalInvoice?.id ?? null,
          reason: cd.reason,
          subtotal: cd.subtotal,
          taxAmount: cd.taxAmount,
          total: cd.total,
          amountApplied: cd.amountApplied,
          balance: cd.balance,
          status: cd.status,
          journalEntryId: null,
        }));
        for (const l of cd.lines) {
          await m.save(m.create(CreditMemoLine, {
            creditMemoId: cm.id,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            lineTotal: l.lineTotal,
            lineOrder: l.lineOrder,
          }));
        }
      }
      console.log('  ✓ 3 credit memos created (1 applied, 2 open)');
    }

    // =================================================================
    // 20. NOTIFICATIONS (admin dashboard alerts)
    // =================================================================
    const notifCount = await m.countBy(Notification, { userId: admin.id } as any);
    if (notifCount === 0) {
      await m.save([
        m.create(Notification, { userId: admin.id, companyId: company.id, type: 'invoice', title: 'Invoice overdue', message: 'INV-003 for Iqbal Grocery is overdue by 5 days', isRead: false, data: {} } as any),
        m.create(Notification, { userId: admin.id, companyId: company.id, type: 'inventory', title: 'Low stock alert', message: 'Dalda Banaspati Ghee 2.5kg is below reorder point (320 < 100)', isRead: false, data: {} } as any),
        m.create(Notification, { userId: admin.id, companyId: company.id, type: 'delivery', title: 'Delivery completed', message: 'Saim Raza completed delivery to Tariq General Store', isRead: true, data: {} } as any),
        m.create(Notification, { userId: admin.id, companyId: company.id, type: 'payment', title: 'Payment received', message: 'PKR 49,140 received from Tariq General Store', isRead: true, data: {} } as any),
        m.create(Notification, { userId: saim.id, companyId: company.id, type: 'delivery', title: 'New delivery assigned', message: 'You have a new delivery for Al-Madina Mart', isRead: false, data: {} } as any),
      ]);
      console.log('  ✓ 5 notifications created');
    }

    console.log('\n  Data created:');
    console.log('    • 3 users (1 admin, 2 delivery personnel)');
    console.log('    • 1 company (MetroMatrix — FMCG Distribution)');
    console.log('    • 14 chart of accounts');
    console.log('    • 8 customers (retail shops)');
    console.log('    • 5 vendors (oil mills, detergent factories)');
    console.log('    • 12 inventory items (cooking oil, detergents, cleaners)');
    console.log('    • 20 invoices with line items (1 year, all statuses)');
    console.log('    • 15 bills with line items (1 year, all statuses)');
    console.log('    • 15 journal entries (14 posted, 1 draft)');
    console.log('    • 2 bank accounts + 30 transactions (1 year)');
    console.log('    • 4 tax rates (GST, WHT, Excise, Zero)');
    console.log('    • 10 sales orders + 6 purchase orders (with line items, full year)');
    console.log('    • 4 estimates (sent, accepted, draft, expired)');
    console.log('    • 3 credit memos (1 applied, 2 open)');
    console.log('    • 1 budget, 3 employees, 1 payroll run');
    console.log('    • 2 delivery personnel profiles');
    console.log('    • Shadow inventory snapshots for both DPs');
    console.log('    • 3 agencies (Dalda Cooking Oil, Suffee Cooking Oil, Suffee Detergents)');
    console.log('    • 5 deliveries with items (various statuses)');
    console.log('    • 5 notifications');
    console.log('\n  Production API: https://finmatrix-api-a824f23fbd72.herokuapp.com/api/v1');
    console.log('  Local dev:      npm run start:dev');
    console.log('  Auth endpoint:  POST /api/v1/auth/signin\n');
  });

  await ds.destroy();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
