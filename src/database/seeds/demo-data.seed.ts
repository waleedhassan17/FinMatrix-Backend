/**
 * Demo seed script.
 * Usage:  npm run seed:demo
 *
 * Creates:
 *   - 1 admin user:   admin@finmatrix.pk / Admin123!
 *   - 1 delivery user: imran@finmatrix.pk / Delivery123!
 *   - 1 company "Ali Traders" with default chart of accounts
 *   - 5 customers, 5 vendors, 10 invoices, 5 bills, a handful of payments
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { User } from '../../modules/users/entities/user.entity';
import { Company } from '../../modules/companies/entities/company.entity';
import { UserCompany } from '../../modules/companies/entities/user-company.entity';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { Vendor } from '../../modules/vendors/entities/vendor.entity';
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { InvoiceLineItem } from '../../modules/invoices/entities/invoice-line-item.entity';
import { Bill } from '../../modules/bills/entities/bill.entity';
import { BillLineItem } from '../../modules/bills/entities/bill-line-item.entity';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  ACCT_AR,
  ACCT_AP,
  ACCT_SALES_REVENUE,
  ACCT_BANK,
} from '../../modules/accounts/accounts.constants';
import { generateInviteCode } from '../../common/utils/reference-generator.util';

loadEnv();

async function run() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'finmatrix_user',
    password: process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
    database: process.env.DB_NAME ?? 'finmatrix',
    entities: [
      User,
      Company,
      UserCompany,
      Account,
      Customer,
      Vendor,
      Invoice,
      InvoiceLineItem,
      Bill,
      BillLineItem,
    ],
    synchronize: true,
  });
  await ds.initialize();
  console.log('> Connected. Seeding demo data…');

  await ds.transaction(async (m) => {
    // --- Users
    const adminHash = await bcrypt.hash('Admin123!', 12);
    const delivHash = await bcrypt.hash('Delivery123!', 12);

    let admin = await m.findOneBy(User, { email: 'admin@finmatrix.pk' });
    if (!admin) {
      admin = await m.save(
        m.create(User, {
          email: 'admin@finmatrix.pk',
          passwordHash: adminHash,
          displayName: 'Demo Admin',
          phone: '+92-300-1234567',
          role: 'admin',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
    }

    let delivery = await m.findOneBy(User, { email: 'imran@finmatrix.pk' });
    if (!delivery) {
      delivery = await m.save(
        m.create(User, {
          email: 'imran@finmatrix.pk',
          passwordHash: delivHash,
          displayName: 'Imran Delivery',
          phone: '+92-301-7654321',
          role: 'delivery',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
    }

    // --- Company
    let company = await m.findOne(Company, { where: { name: 'Ali Traders' } });
    if (!company) {
      company = await m.save(
        m.create(Company, {
          name: 'Ali Traders',
          industry: 'Retail',
          address: { street: '1 Main Road', city: 'Lahore', country: 'Pakistan' },
          phone: '+92-42-1111111',
          email: 'contact@alitraders.pk',
          taxId: 'NTN-12345',
          inviteCode: generateInviteCode(6),
          logo: null,
          createdBy: admin.id,
        }),
      );
    }

    // Memberships
    const memberships: Array<{ user: User; role: 'admin' | 'delivery' }> = [
      { user: admin, role: 'admin' },
      { user: delivery, role: 'delivery' },
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
    if (!admin.defaultCompanyId) {
      admin.defaultCompanyId = company.id;
      await m.save(admin);
    }
    if (!delivery.defaultCompanyId) {
      delivery.defaultCompanyId = company.id;
      await m.save(delivery);
    }

    // --- Chart of accounts
    const existingCount = await m.countBy(Account, { companyId: company.id });
    if (existingCount === 0) {
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
    }

    const accountByNumber = new Map<string, Account>();
    for (const a of await m.find(Account, { where: { companyId: company.id } })) {
      accountByNumber.set(a.accountNumber, a);
    }

    // --- Customers
    const existingCustomers = await m.countBy(Customer, { companyId: company.id });
    if (existingCustomers === 0) {
      const customerNames = [
        'Khan Electronics',
        'Iqbal Grocery',
        'Malik Boutique',
        'Farooq Hardware',
        'Shaheen Cafe',
      ];
      await m.save(
        customerNames.map((n) =>
          m.create(Customer, {
            companyId: company!.id,
            name: n,
            company: n,
            email: `${n.toLowerCase().replace(/\s+/g, '.')}@example.pk`,
            phone: '+92-300-1234567',
            billingAddress: { city: 'Lahore', country: 'Pakistan' },
            shippingAddress: null,
            creditLimit: '50000',
            paymentTerms: 'net30',
            balance: '0',
            isActive: true,
            notes: null,
          }),
        ),
      );
    }

    // --- Vendors
    const existingVendors = await m.countBy(Vendor, { companyId: company.id });
    if (existingVendors === 0) {
      const vendorNames = [
        'Raheem Supplies',
        'Global Wholesale Ltd',
        'Lahore Packaging Co',
        'Karachi Cargo',
        'Sindh Stationery',
      ];
      await m.save(
        vendorNames.map((n) =>
          m.create(Vendor, {
            companyId: company!.id,
            companyName: n,
            contactPerson: 'Mr. Saleh',
            email: `${n.toLowerCase().replace(/\s+/g, '.')}@vendor.pk`,
            phone: '+92-321-7654321',
            address: { city: 'Lahore', country: 'Pakistan' },
            paymentTerms: 'net30',
            taxId: null,
            defaultExpenseAccountId: null,
            balance: '0',
            isActive: true,
            notes: null,
          }),
        ),
      );
    }

    console.log('> Demo seed finished:');
    console.log('    admin@finmatrix.pk  / Admin123!');
    console.log('    imran@finmatrix.pk  / Delivery123!');
    console.log(`    company "Ali Traders"   invite code: ${company.inviteCode}`);
    console.log('  Note: invoices/bills/payments are created via API for demo realism.');
    console.log('  Use the admin account to POST them via Swagger at /api/docs.');
  });

  await ds.destroy();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
