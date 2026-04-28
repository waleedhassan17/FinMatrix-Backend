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
 *   Admin:     waleedhassansfd@gmail.com / MetroMatrix2026!
 *   DP #1:     saim@metromatrix.com      / Delivery2026!
 *   DP #2:     haseeb@metromatrix.com    / Delivery2026!
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
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { InvoiceLineItem } from '../../modules/invoices/entities/invoice-line-item.entity';
import { Bill } from '../../modules/bills/entities/bill.entity';
import { BillLineItem } from '../../modules/bills/entities/bill-line-item.entity';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
} from '../../modules/accounts/accounts.constants';
import { generateInviteCode } from '../../common/utils/reference-generator.util';

loadEnv();

// =====================================================================
// PASSWORDS
// =====================================================================
const ADMIN_PASSWORD = '123456';
const DP_PASSWORD = '123456';

async function run() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'finmatrix_user',
    password: process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
    database: process.env.DB_NAME ?? 'finmatrix',
    entities: [
      User, Company, UserCompany, Account, Customer, Vendor,
      InventoryItem, Delivery, DeliveryItem,
      DeliveryPersonnelProfile, ShadowInventorySnapshot, Agency,
      Invoice, InvoiceLineItem, Bill, BillLineItem,
    ],
    synchronize: true,
  });
  await ds.initialize();
  console.log('> Connected. Seeding MetroMatrix production data…\n');

  await ds.transaction(async (m) => {
    // =================================================================
    // 1. USERS
    // =================================================================
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const dpHash = await bcrypt.hash(DP_PASSWORD, 12);

    let admin = await m.findOneBy(User, { email: 'waleedhassansfd@gmail.com' });
    if (!admin) {
      admin = await m.save(
        m.create(User, {
          email: 'waleedhassansfd@gmail.com',
          passwordHash: adminHash,
          displayName: 'Waleed Hassan',
          phone: '+92-300-1234567',
          role: 'admin',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
      console.log('  ✓ Admin user created: waleedhassansfd@gmail.com');
    } else {
      // Update password to make sure it's current
      admin.passwordHash = adminHash;
      admin.isActive = true;
      await m.save(admin);
      console.log('  ✓ Admin user exists, password updated');
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
        }),
      );
      console.log(`  ✓ Company "MetroMatrix" created (invite: ${company.inviteCode})`);
    } else {
      console.log(`  ✓ Company "MetroMatrix" exists (invite: ${company.inviteCode})`);
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
    for (const dp of [saim, haseeb]) {
      const existing = await m.findOneBy(DeliveryPersonnelProfile, { userId: dp.id });
      if (!existing) {
        await m.save(
          m.create(DeliveryPersonnelProfile, {
            userId: dp.id,
            companyId: company.id,
            vehicleType: dp.id === saim.id ? 'motorcycle' : 'pickup',
            vehicleNumber: dp.id === saim.id ? 'LEA-4521' : 'LEC-8832',
            zones: dp.id === saim.id
              ? ['Lahore-Central', 'Lahore-East']
              : ['Lahore-West', 'Lahore-South'],
            maxLoad: dp.id === saim.id ? '200' : '500',
            currentLoad: '0',
            isAvailable: true,
            status: 'active',
            rating: '4.80',
            totalDeliveries: dp.id === saim.id ? 156 : 203,
            onTimeRate: dp.id === saim.id ? '94.50' : '91.20',
          }),
        );
      }
    }
    console.log('  ✓ Delivery personnel profiles created');

    // =================================================================
    // 9. SHADOW INVENTORY SNAPSHOTS (for DP mobile app)
    // =================================================================
    const existingShadow = await m.countBy(ShadowInventorySnapshot, { companyId: company.id });
    if (existingShadow === 0) {
      // Give Saim the first 6 items, Haseeb the rest
      const saimItems = items.slice(0, 6);
      const haseebItems = items.slice(6);
      const snapshots = [
        ...saimItems.map((item) => m.create(ShadowInventorySnapshot, {
          companyId: company!.id,
          personnelId: saim.id,
          itemId: item.id,
          originalQty: item.quantityOnHand,
          currentQty: item.quantityOnHand,
          lastSyncAt: new Date(),
          syncStatus: 'synced',
        })),
        ...haseebItems.map((item) => m.create(ShadowInventorySnapshot, {
          companyId: company!.id,
          personnelId: haseeb.id,
          itemId: item.id,
          originalQty: item.quantityOnHand,
          currentQty: item.quantityOnHand,
          lastSyncAt: new Date(),
          syncStatus: 'synced',
        })),
      ];
      await m.save(snapshots);
      console.log('  ✓ Shadow inventory snapshots created for both DPs');
    }

    // =================================================================
    // 10. AGENCIES
    // =================================================================
    const existingAgencies = await m.countBy(Agency, { companyId: company.id });
    if (existingAgencies === 0) {
      await m.save([
        m.create(Agency, {
          companyId: company.id,
          name: 'TCS Express',
          type: 'distribution',
          description: 'National courier — used for inter-city shipments',
          address: { city: 'Lahore', country: 'Pakistan' },
          contact: { phone: '+92-42-111-827-827', email: 'support@tcs.pk' },
          isConnected: true,
          lastSyncAt: new Date(),
        }),
        m.create(Agency, {
          companyId: company.id,
          name: 'Leopards Courier',
          type: 'distribution',
          description: 'Fast delivery — Lahore metro area',
          address: { city: 'Lahore', country: 'Pakistan' },
          contact: { phone: '+92-42-111-300-786', email: 'ops@leopardscourier.pk' },
          isConnected: false,
          lastSyncAt: null,
        }),
      ]);
      console.log('  ✓ 2 agencies created');
    }

    // =================================================================
    // 11. DELIVERIES (realistic — various statuses for dashboard)
    // =================================================================
    const allCustomers = await m.find(Customer, { where: { companyId: company.id } });
    const existingDeliveries = await m.countBy(Delivery, { companyId: company.id });
    if (existingDeliveries === 0 && allCustomers.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      const deliveryData = [
        // Saim's deliveries
        { customer: 0, dp: saim, status: 'delivered' as const, date: yesterday, notes: 'All items received. Customer signed.' },
        { customer: 1, dp: saim, status: 'in_transit' as const, date: today, notes: 'On the way — ETA 30 min' },
        { customer: 2, dp: saim, status: 'arrived' as const, date: today, notes: 'At customer location, waiting for unload' },
        { customer: 3, dp: saim, status: 'pending' as const, date: today, notes: 'Scheduled for afternoon' },
        // Haseeb's deliveries
        { customer: 4, dp: haseeb, status: 'delivered' as const, date: yesterday, notes: '2 items returned (damaged)' },
        { customer: 5, dp: haseeb, status: 'in_transit' as const, date: today, notes: 'Left warehouse 10:15 AM' },
        { customer: 6, dp: haseeb, status: 'pending' as const, date: today, notes: null },
        // Unassigned
        { customer: 7, dp: null, status: 'unassigned' as const, date: today, notes: 'Needs DP assignment' },
      ];

      for (const d of deliveryData) {
        const delivery = await m.save(
          m.create(Delivery, {
            companyId: company.id,
            customerId: allCustomers[d.customer].id,
            personnelId: d.dp?.id ?? null,
            status: d.status,
            priority: d.customer < 3 ? 'high' : 'normal',
            preferredDate: d.date,
            preferredTimeSlot: d.customer % 2 === 0 ? '09:00-12:00' : '14:00-17:00',
            assignedAt: d.dp ? new Date() : null,
            completedAt: d.status === 'delivered' ? new Date() : null,
            notes: d.notes,
            cancelReason: null,
            createdBy: admin.id,
          }),
        );

        // Add 2-4 random items per delivery
        const numItems = 2 + (d.customer % 3);
        const deliveryItems: DeliveryItem[] = [];
        for (let i = 0; i < numItems && i < items.length; i++) {
          const item = items[(d.customer * 2 + i) % items.length];
          const orderedQty = 20 + (d.customer * 5) + (i * 10);
          deliveryItems.push(
            m.create(DeliveryItem, {
              deliveryId: delivery.id,
              itemId: item.id,
              orderedQty: String(orderedQty),
              deliveredQty: d.status === 'delivered' ? String(orderedQty) : '0',
              returnedQty: d.customer === 4 && i === 0 ? '5' : '0',
              unitPrice: item.sellingPrice,
            }),
          );
        }
        await m.save(deliveryItems);
      }
      console.log('  ✓ 8 deliveries created (2 delivered, 2 in-transit, 1 arrived, 2 assigned, 1 unassigned)');
    }

    // =================================================================
    // DONE
    // =================================================================
    console.log('\n' + '='.repeat(60));
    console.log('  MetroMatrix seed completed successfully!');
    console.log('='.repeat(60));
    console.log('\n  Login Credentials:');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Admin:  waleedhassansfd@gmail.com / ${ADMIN_PASSWORD}`);
    console.log(`  DP #1:  saim@metromatrix.com      / ${DP_PASSWORD}`);
    console.log(`  DP #2:  haseeb@metromatrix.com    / ${DP_PASSWORD}`);
    console.log(`  Company invite code: ${company.inviteCode}`);
    console.log('  ─────────────────────────────────────────────');
    console.log('\n  Data created:');
    console.log('    • 3 users (1 admin, 2 delivery personnel)');
    console.log('    • 1 company (MetroMatrix — FMCG Distribution)');
    console.log('    • 14 chart of accounts');
    console.log('    • 8 customers (retail shops)');
    console.log('    • 5 vendors (oil mills, detergent factories)');
    console.log('    • 12 inventory items (cooking oil, detergents, cleaners)');
    console.log('    • 2 delivery personnel profiles');
    console.log('    • Shadow inventory snapshots for both DPs');
    console.log('    • 2 agencies (TCS Express, Leopards)');
    console.log('    • 8 deliveries with items (various statuses)');
    console.log('\n  Now start the server: npm run start:dev');
    console.log('  Then log in at: POST /api/v1/auth/signin\n');
  });

  await ds.destroy();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
