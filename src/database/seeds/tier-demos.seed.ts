/**
 * Three-tier demo companies (FinMatrix.md Phase 4)
 * ================================================
 * Usage:  npm run seed:tier-demos            (local/staging)
 *         node dist/database/seeds/tier-demos.seed.js
 *
 * Seeds three active, approved demo companies — one per tier, each on one of
 * its two plans — THROUGH THE REAL SERVICES so every document posts a
 * balanced double-entry journal:
 *
 *   SMALL BUSINESS  "Sukoon"        sukoon@gmail.com       / 123456  (small_business_6mo)
 *     service invoices + payments, expense bills — NO inventory, NO COGS.
 *   LARGE ORG       "MetroMatrix"   metromatrix@gmail.com  / 123456  (large_org_6mo)
 *     service invoices/bills + employees + a PROCESSED payroll run + budget.
 *     NO deliveries (existing rider logins remain but the module is gated).
 *   WAREHOUSE       "Warehouse Co"  warehouse@gmail.com    / 123456  (warehouse_3mo)
 *     inventory via PO→GRNI, item invoices, TWO riders with credentials,
 *     and deliveries in every state: delivered+PAID, delivered+UNPAID
 *     (open invoice in A/R), returned (reversed + restocked), in-transit
 *     (value parked in Goods in Transit) and freshly assigned.
 *
 * Idempotent: wipes ONLY these three companies' transactional data and
 * regenerates it. After each company it asserts Trial Balance + Balance
 * Sheet balance, and for Warehouse Co that Inventory Valuation ties to GL
 * 1200 and Goods in Transit equals exactly the in-transit deliveries' cost
 * (i.e. nets to ZERO across completed ones). Exits non-zero if a tie fails.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../../app.module';
import { Company } from '../../modules/companies/entities/company.entity';
import { User } from '../../modules/users/entities/user.entity';
import { UserCompany } from '../../modules/companies/entities/user-company.entity';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { Vendor } from '../../modules/vendors/entities/vendor.entity';
import { InventoryItem } from '../../modules/inventory/entities/inventory-item.entity';
import { TaxRate } from '../../modules/tax/entities/tax-rate.entity';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Bill } from '../../modules/bills/entities/bill.entity';
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { CompaniesService } from '../../modules/companies/companies.service';
import { InvoicesService } from '../../modules/invoices/invoices.service';
import { BillsService } from '../../modules/bills/bills.service';
import { PaymentsService } from '../../modules/payments/payments.service';
import { PurchaseOrdersService } from '../../modules/purchase-orders/purchase-orders.service';
import { PostingService } from '../../modules/journal-entries/posting.service';
import { PayrollService } from '../../modules/payroll/payroll.service';
import { BudgetsService } from '../../modules/budgets/budgets.service';
import { DeliveryPersonnelService } from '../../modules/delivery-personnel/delivery-personnel.service';
import { DeliveriesService } from '../../modules/deliveries/deliveries.service';
import { InventoryApprovalsService } from '../../modules/inventory-approvals/inventory-approvals.service';
import { ReportsService } from '../../modules/reports/reports.service';
import { getPlanConfig, PlanKey } from '../../modules/billing/plan-config';
import {
  ACCT_CASH,
  ACCT_OPENING_BALANCE_EQUITY,
} from '../../modules/accounts/accounts.constants';

loadEnv();

const PASSWORD = '123456';
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = new Date();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let tieFailures = 0;

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const companiesSvc = app.get(CompaniesService);
  const invoices = app.get(InvoicesService);
  const bills = app.get(BillsService);
  const payments = app.get(PaymentsService);
  const pos = app.get(PurchaseOrdersService);
  const posting = app.get(PostingService);
  const payroll = app.get(PayrollService);
  const budgets = app.get(BudgetsService);
  const personnel = app.get(DeliveryPersonnelService);
  const deliveries = app.get(DeliveriesService);
  const approvals = app.get(InventoryApprovalsService);
  const reports = app.get(ReportsService);

  console.log('> Seeding the three tier demo companies through the ledger…\n');

  // ─── Shared helpers ────────────────────────────────────────────────────

  const ensureAdminUser = async (email: string, displayName: string): Promise<User> => {
    const repo = ds.getRepository(User);
    let u = await repo.findOne({ where: { email } });
    const hash = await bcrypt.hash(PASSWORD, 12);
    if (!u) {
      u = repo.create({
        email,
        passwordHash: hash,
        displayName,
        phone: '+92-300-7770001',
        role: 'admin',
        isActive: true,
        isEmailVerified: true,
      } as Partial<User>);
    } else {
      u.passwordHash = hash;
      u.isActive = true;
      (u as any).role = 'admin';
      (u as any).isEmailVerified = true;
    }
    return repo.save(u);
  };

  const ensureCompany = async (
    name: string,
    adminEmail: string,
    displayName: string,
    companyType: string,
    plan: PlanKey,
    industry: string,
  ): Promise<{ cid: string; uid: string }> => {
    const admin = await ensureAdminUser(adminEmail, displayName);
    const companyRepo = ds.getRepository(Company);
    let company = await companyRepo.findOne({ where: { name } });
    if (!company) {
      // Real service call: seeds the chart of accounts + membership too.
      company = await companiesSvc.create(admin.id, { name, industry, companyType } as any);
    }
    // Membership (idempotent).
    const ucRepo = ds.getRepository(UserCompany);
    const membership = await ucRepo.findOne({ where: { userId: admin.id, companyId: company.id } });
    if (!membership) {
      await ucRepo.save(ucRepo.create({ userId: admin.id, companyId: company.id, role: 'admin' }));
    }
    if (!admin.defaultCompanyId) {
      admin.defaultCompanyId = company.id;
      await ds.getRepository(User).save(admin);
    }
    // Active + approved on the requested tier/plan, expiry from PLAN_CONFIG.
    const cfg = getPlanConfig(plan);
    const start = new Date();
    const expiry = new Date(start);
    expiry.setMonth(expiry.getMonth() + (cfg.durationMonths ?? 6));
    await ds.query(
      `UPDATE companies SET
         company_type=$2, subscription_plan=$3, subscription_status='active',
         subscription_start_date=$4, subscription_expiry_date=$5,
         payment_status='paid', status='approved', setup_completed=true,
         all_features_unlocked=false
       WHERE id=$1`,
      [company.id, companyType, plan, start, expiry],
    );
    return { cid: company.id, uid: admin.id };
  };

  const resetCompanyData = async (cid: string) => {
    const del = (sql: string) => ds.query(sql, [cid]).catch(() => undefined);
    await del(`DELETE FROM payment_applications WHERE payment_id IN (SELECT id FROM payments WHERE company_id=$1)`);
    await del(`DELETE FROM payments WHERE company_id=$1`);
    await del(`DELETE FROM bill_payments WHERE company_id=$1`);
    await del(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id=$1)`);
    await del(`DELETE FROM invoices WHERE company_id=$1`);
    await del(`DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE company_id=$1)`);
    await del(`DELETE FROM bills WHERE company_id=$1`);
    await del(`DELETE FROM sales_order_line_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id=$1)`);
    await del(`DELETE FROM sales_orders WHERE company_id=$1`);
    await del(`DELETE FROM purchase_order_lines WHERE order_id IN (SELECT id FROM purchase_orders WHERE company_id=$1)`);
    await del(`DELETE FROM purchase_orders WHERE company_id=$1`);
    await del(`DELETE FROM journal_entry_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id=$1)`);
    await del(`DELETE FROM journal_entries WHERE company_id=$1`);
    await del(`DELETE FROM general_ledger WHERE company_id=$1`);
    await del(`DELETE FROM inventory_movements WHERE company_id=$1`);
    await del(`DELETE FROM inventory_adjustments WHERE company_id=$1`);
    await del(`DELETE FROM tax_payments WHERE company_id=$1`);
    await del(`DELETE FROM payroll_items WHERE run_id IN (SELECT id FROM payroll_runs WHERE company_id=$1)`);
    await del(`DELETE FROM payroll_runs WHERE company_id=$1`);
    await del(`DELETE FROM employees WHERE company_id=$1`);
    await del(`DELETE FROM budget_lines WHERE budget_id IN (SELECT id FROM budgets WHERE company_id=$1)`);
    await del(`DELETE FROM budgets WHERE company_id=$1`);
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
    await del(`DELETE FROM customers WHERE company_id=$1`);
    await del(`DELETE FROM vendors WHERE company_id=$1`);
    await del(`DELETE FROM inventory_items WHERE company_id=$1`);
    await del(`DELETE FROM tax_rates WHERE company_id=$1`);
    await del(`UPDATE accounts SET balance = opening_balance WHERE company_id=$1`);
  };

  const postOpeningCash = async (cid: string, uid: string, amount: string) => {
    const acctRepo = ds.getRepository(Account);
    const cash = await acctRepo.findOneByOrFail({ companyId: cid, accountNumber: ACCT_CASH });
    const obe = await acctRepo.findOneByOrFail({ companyId: cid, accountNumber: ACCT_OPENING_BALANCE_EQUITY });
    const openDate = ymd(new Date(TODAY.getFullYear(), TODAY.getMonth() - 7, 1));
    await ds.transaction(async (manager) => {
      await posting.createEntry(manager, {
        companyId: cid,
        date: openDate,
        memo: 'Opening cash balance',
        createdBy: uid,
        status: 'posted',
        sourceType: 'opening_balance',
        sourceId: cash.id,
        lines: [
          { accountId: cash.id, description: 'Opening cash', debit: `${amount}.0000`, credit: '0', lineOrder: 0 },
          { accountId: obe.id, description: 'Opening balance offset', debit: '0', credit: `${amount}.0000`, lineOrder: 1 },
        ],
      });
    });
    return cash.id;
  };

  const mkCustomers = async (cid: string, names: string[], domain: string) => {
    const repo = ds.getRepository(Customer);
    return repo.save(
      names.map((n, i) =>
        repo.create({
          companyId: cid, name: n, company: n,
          email: `cust${i + 1}@${domain}`, phone: `+92-300-55522${i}${i}`,
          billingAddress: { city: 'Lahore', country: 'Pakistan' },
          shippingAddress: { city: 'Lahore', country: 'Pakistan' },
          creditLimit: '500000', paymentTerms: 'net30', balance: '0', isActive: true, notes: null,
        }),
      ),
    );
  };

  const mkVendors = async (cid: string, names: string[], domain: string) => {
    const repo = ds.getRepository(Vendor);
    return repo.save(
      names.map((n, i) =>
        repo.create({
          companyId: cid, companyName: n, contactPerson: `Mr. ${n.split(' ')[0]}`,
          email: `vendor${i + 1}@${domain}`, phone: `+92-42-88833${i}00`,
          address: { city: 'Lahore', country: 'Pakistan' }, paymentTerms: 'net30',
          taxId: null, defaultExpenseAccountId: null, balance: '0', isActive: true, notes: null,
        }),
      ),
    );
  };

  const mkGst = async (cid: string) => {
    const repo = ds.getRepository(TaxRate);
    await repo.save(repo.create({
      companyId: cid, name: 'GST (17%)', rate: '17', type: 'sales' as any,
      authority: 'FBR', isActive: true, isDefault: true,
    }));
  };

  const day = (monthsAgo: number, n: number) => {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - monthsAgo, n);
    return ymd(d > TODAY ? TODAY : d);
  };

  const assertBooks = async (label: string, cid: string) => {
    const tb = await reports.trialBalance(cid, '1970-01-01', '2999-12-31');
    const bs = await reports.balanceSheet(cid, ymd(TODAY));
    const tbOk = (tb as any)?.isBalanced === true;
    const bsOk = (bs as any)?.isBalanced === true;
    if (!tbOk || !bsOk) tieFailures++;
    console.log(`  ${tbOk ? '✓' : '✗'} ${label}: Trial Balance balanced (Dr ${(tb as any)?.totalDebits} = Cr ${(tb as any)?.totalCredits})`);
    console.log(`  ${bsOk ? '✓' : '✗'} ${label}: Balance Sheet balanced (A ${(bs as any)?.totalAssets} = L+E)`);
  };

  // ═══ 1. SUKOON — small business (service-only books) ═══
  {
    console.log('— Sukoon (small_business_6mo)');
    const { cid, uid } = await ensureCompany(
      'Sukoon', 'sukoon@gmail.com', 'Sukoon Admin', 'small_business', 'small_business_6mo', 'Consulting',
    );
    await resetCompanyData(cid);
    const customers = await mkCustomers(cid, ['Noor Traders', 'Hilal Foods', 'Barkat Textiles', 'Amanah Stores'], 'sukoon.pk');
    const vendors = await mkVendors(cid, ['City Print House', 'Metro Internet'], 'sukoon.pk');
    await mkGst(cid);
    const cashId = await postOpeningCash(cid, uid, '100000');
    const acctRepo = ds.getRepository(Account);
    const rent = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6000' });
    const util = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6100' });

    const services = ['Bookkeeping retainer', 'Consulting hours', 'Tax filing service', 'Advisory session'];
    let inv = 0, pay = 0, bill = 0;
    for (let m = 5; m >= 0; m--) {
      for (let k = 0; k < 2; k++) {
        // SERVICE lines only — no itemId, so no COGS/inventory ever posts.
        const cust = customers[(m + k) % customers.length];
        const doc = await invoices.create(cid, uid, {
          customerId: cust.id, invoiceDate: day(m, 6 + k * 8), dueDate: day(m, 26),
          status: 'sent', discountType: 'none', discountValue: '0',
          lines: [{ description: services[(m + k) % services.length], quantity: '1', unitPrice: String(25000 + k * 10000), taxRate: '0' }],
        } as any);
        inv++;
        if ((m * 2 + k) % 5 !== 0) {
          const full = await ds.getRepository(Invoice).findOneBy({ id: doc.id });
          if (full) {
            await payments.receive(cid, uid, {
              customerId: cust.id, paymentDate: day(m, 27), paymentMethod: 'cash',
              amount: full.total, bankAccountId: cashId,
              applications: [{ invoiceId: doc.id, amount: full.total }],
            } as any);
            pay++;
          }
        }
      }
      const exp = m % 2 === 0 ? rent : util;
      if (exp) {
        const eb = await bills.create(cid, uid, {
          vendorId: vendors[m % vendors.length].id,
          billNumber: `SUK-EXP-${m}`, billDate: day(m, 3), dueDate: day(m, 18), status: 'open',
          lines: [{ accountId: exp.id, description: m % 2 === 0 ? 'Office rent' : 'Internet & utilities', amount: '8000', taxRate: '0' }],
        } as any);
        bill++;
        const full = await ds.getRepository(Bill).findOneBy({ id: eb.id });
        if (full) {
          await bills.pay(cid, uid, {
            vendorId: full.vendorId, paymentDate: day(m, 16), paymentMethod: 'cash',
            bankAccountId: cashId, applications: [{ billId: eb.id, amount: full.balance }],
          } as any);
          pay++;
        }
      }
    }
    // Prove the safeguard: a service-only company posts ZERO COGS.
    const cogs = await ds.query(
      `SELECT COALESCE(SUM(g.debit - g.credit),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND a.account_number='5000'`,
      [cid],
    );
    const cogsOk = Number(cogs[0]?.v ?? 0) === 0;
    if (!cogsOk) tieFailures++;
    console.log(`  ✓ ${inv} service invoices, ${bill} expense bills, ${pay} payments`);
    console.log(`  ${cogsOk ? '✓' : '✗'} NO COGS posted (service-only books)`);
    await assertBooks('Sukoon', cid);
  }

  // ═══ 2. METROMATRIX — large organization (payroll + budgets, no deliveries) ═══
  {
    console.log('\n— MetroMatrix (large_org_6mo)');
    const { cid, uid } = await ensureCompany(
      'MetroMatrix', 'metromatrix@gmail.com', 'MetroMatrix Admin', 'large_org', 'large_org_6mo', 'Distribution Services',
    );
    await resetCompanyData(cid);
    const customers = await mkCustomers(cid, ['Tariq General Store', 'Al-Madina Mart', 'Iqbal Grocery', 'Rehman Superstore', 'City Wholesale'], 'metromatrix.com');
    const vendors = await mkVendors(cid, ['Habib Services', 'Pak Logistics', 'Sufi Supplies'], 'metromatrix.com');
    await mkGst(cid);
    const cashId = await postOpeningCash(cid, uid, '400000');
    const acctRepo = ds.getRepository(Account);
    const rent = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6000' });
    const util = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6100' });
    const salaryExp = await acctRepo.findOneBy({ companyId: cid, accountNumber: '6200' });

    let inv = 0, pay = 0, bill = 0;
    for (let m = 5; m >= 0; m--) {
      for (let k = 0; k < 3; k++) {
        const cust = customers[(m + k) % customers.length];
        const doc = await invoices.create(cid, uid, {
          customerId: cust.id, invoiceDate: day(m, 5 + k * 7), dueDate: day(m, 28),
          status: 'sent', discountType: 'none', discountValue: '0',
          lines: [{ description: 'Distribution & handling services', quantity: '1', unitPrice: String(60000 + k * 15000), taxRate: '17' }],
        } as any);
        inv++;
        if ((m * 3 + k) % 6 !== 0) {
          const full = await ds.getRepository(Invoice).findOneBy({ id: doc.id });
          if (full) {
            await payments.receive(cid, uid, {
              customerId: cust.id, paymentDate: day(m, 26), paymentMethod: 'cash',
              amount: full.total, bankAccountId: cashId,
              applications: [{ invoiceId: doc.id, amount: full.total }],
            } as any);
            pay++;
          }
        }
      }
      const exp = m % 2 === 0 ? rent : util;
      if (exp) {
        const eb = await bills.create(cid, uid, {
          vendorId: vendors[m % vendors.length].id,
          billNumber: `MM-EXP-${m}`, billDate: day(m, 4), dueDate: day(m, 20), status: 'open',
          lines: [{ accountId: exp.id, description: m % 2 === 0 ? 'Warehouse rent' : 'Utilities', amount: '25000', taxRate: '0' }],
        } as any);
        bill++;
        const full = await ds.getRepository(Bill).findOneBy({ id: eb.id });
        if (full) {
          await bills.pay(cid, uid, {
            vendorId: full.vendorId, paymentDate: day(m, 18), paymentMethod: 'cash',
            bankAccountId: cashId, applications: [{ billId: eb.id, amount: full.balance }],
          } as any);
          pay++;
        }
      }
    }
    console.log(`  ✓ ${inv} invoices, ${bill} bills, ${pay} payments`);

    // Employees + a PROCESSED payroll run (posts Dr Salary / Cr Cash + Tax).
    const emps = [
      { firstName: 'Ayesha', lastName: 'Khan', position: 'Accountant', salary: '90000' },
      { firstName: 'Bilal', lastName: 'Ahmed', position: 'Operations Manager', salary: '120000' },
      { firstName: 'Sana', lastName: 'Raza', position: 'Sales Executive', salary: '70000' },
    ];
    for (const e of emps) {
      await payroll.createEmployee(cid, {
        ...e, payType: 'salary', payFrequency: 'monthly', deductionAmount: '5000',
        hireDate: day(5, 1), email: `${e.firstName.toLowerCase()}@metromatrix.com`,
      } as any);
    }
    const periodStart = day(1, 1);
    const periodEnd = day(1, 28);
    const runDoc = await payroll.createRun(cid, uid, {
      payPeriod: 'Last month', periodStart, periodEnd, payDate: day(0, 1),
    } as any);
    await payroll.processRun(cid, (runDoc as any).id, uid);
    console.log(`  ✓ ${emps.length} employees + processed payroll run`);

    // Budget vs actual for the running fiscal year.
    if (rent && util && salaryExp) {
      const twelve = (v: number) => Array.from({ length: 12 }, () => v);
      await budgets.create(cid, uid, {
        name: `FY${TODAY.getFullYear()} Operating Budget`, fiscalYear: TODAY.getFullYear(), status: 'active',
        lines: [
          { accountId: rent.id, monthlyAmounts: twelve(25000) },
          { accountId: util.id, monthlyAmounts: twelve(25000) },
          { accountId: salaryExp.id, monthlyAmounts: twelve(290000) },
        ],
      } as any);
      console.log('  ✓ budget with 3 account lines (vs-actual ready)');
    }
    await assertBooks('MetroMatrix', cid);
  }

  // ═══ 3. WAREHOUSE CO — full inventory + deliveries in every state ═══
  {
    console.log('\n— Warehouse Co (warehouse_3mo)');
    const { cid, uid } = await ensureCompany(
      'Warehouse Co', 'warehouse@gmail.com', 'Warehouse Admin', 'warehouse', 'warehouse_3mo', 'FMCG Distribution',
    );
    await resetCompanyData(cid);
    const customers = await mkCustomers(cid, ['Karim Store', 'Bismillah Mart', 'Faisal Traders', 'Madina Wholesale'], 'warehouseco.pk');
    const vendors = await mkVendors(cid, ['Habib Oil Mills', 'Pak Detergents'], 'warehouseco.pk');
    await mkGst(cid);
    const cashId = await postOpeningCash(cid, uid, '300000');

    // TWO riders with credentials (through the real service: user + profile).
    const riderDefs = [
      { email: 'rider1@warehouseco.com', name: 'Saim Raza' },
      { email: 'rider2@warehouseco.com', name: 'Haseeb Ali' },
    ];
    const riderIds: string[] = [];
    for (const r of riderDefs) {
      const existing = await ds.getRepository(User).findOne({ where: { email: r.email } });
      if (existing) {
        existing.passwordHash = await bcrypt.hash(PASSWORD, 12);
        existing.isActive = true;
        await ds.getRepository(User).save(existing);
        await ds.query(
          `UPDATE delivery_personnel_profiles SET status='active' WHERE user_id=$1 AND company_id=$2`,
          [existing.id, cid],
        );
        riderIds.push(existing.id);
      } else {
        const created = await personnel.create(cid, { email: r.email, password: PASSWORD, name: r.name } as any);
        riderIds.push((created as any).userId ?? (created as any).user?.id);
      }
    }
    console.log(`  ✓ riders: ${riderDefs.map(r => r.email).join(', ')} / ${PASSWORD}`);

    // Inventory via the real PO → receive (GRNI) → bill → pay cycle.
    const itemRepo = ds.getRepository(InventoryItem);
    const items = await itemRepo.save(
      [
        { sku: 'WC-OIL-5L', name: 'Cooking Oil 5L', cost: '1800', sell: '2350' },
        { sku: 'WC-DET-1KG', name: 'Detergent 1KG', cost: '400', sell: '540' },
        { sku: 'WC-GHEE-1KG', name: 'Ghee 1KG', cost: '950', sell: '1250' },
        { sku: 'WC-RICE-5KG', name: 'Basmati Rice 5KG', cost: '1400', sell: '1850' },
      ].map((p) =>
        itemRepo.create({
          companyId: cid, sku: p.sku, name: p.name, description: null, category: 'FMCG',
          unitOfMeasure: 'unit', costMethod: 'average', unitCost: p.cost, sellingPrice: p.sell,
          quantityOnHand: '0', quantityOnOrder: '0', quantityCommitted: '0', reorderPoint: '20',
          reorderQuantity: '100', minStock: '10', maxStock: '2000', sourceAgencyId: null,
          locationId: null, serialTracking: false, lotTracking: false, barcodeData: null, isActive: true,
        }),
      ),
    );

    let poCount = 0, inv = 0, pay = 0;
    for (let m = 3; m >= 0; m--) {
      const A = items[m % items.length];
      const B = items[(m + 1) % items.length];
      const po = await pos.create(cid, {
        vendorId: vendors[m % vendors.length].id,
        orderDate: day(m, 2),
        lines: [A, B].map((it) => ({ itemId: it.id, description: it.name, orderedQty: '40', unitCost: it.unitCost, taxRate: '0' })),
      } as any);
      const poFull = await pos.getById(cid, po.id).catch(() => null);
      const lines = (poFull as any)?.lines ?? (po as any).lines ?? [];
      await pos.receive(cid, uid, po.id, { lines: lines.map((l: any) => ({ lineId: l.id, receivedQty: '40' })) } as any);
      const { billId } = await pos.createBill(cid, uid, po.id, { billNumber: `WC-PB-${m}`, billDate: day(m, 4), dueDate: day(m, 24) } as any);
      poCount++;
      const b = await ds.getRepository(Bill).findOneBy({ id: billId });
      if (b) {
        await bills.pay(cid, uid, {
          vendorId: b.vendorId, paymentDate: day(m, 20), paymentMethod: 'cash',
          bankAccountId: cashId, applications: [{ billId, amount: b.balance }],
        } as any);
        pay++;
      }
      // Two over-the-counter item invoices per month (posts COGS + stock ↓).
      for (let k = 0; k < 2; k++) {
        const cust = customers[(m + k) % customers.length];
        const doc = await invoices.create(cid, uid, {
          customerId: cust.id, invoiceDate: day(m, 9 + k * 6), dueDate: day(m, 28),
          status: 'sent', discountType: 'none', discountValue: '0',
          lines: [
            { description: A.name, quantity: '8', unitPrice: A.sellingPrice, taxRate: '17', itemId: A.id },
            { description: B.name, quantity: '8', unitPrice: B.sellingPrice, taxRate: '17', itemId: B.id },
          ],
        } as any);
        inv++;
        const full = await ds.getRepository(Invoice).findOneBy({ id: doc.id });
        if (full && (m + k) % 4 !== 0) {
          await payments.receive(cid, uid, {
            customerId: cust.id, paymentDate: day(m, 25), paymentMethod: 'cash',
            amount: full.total, bankAccountId: cashId,
            applications: [{ invoiceId: doc.id, amount: full.total }],
          } as any);
          pay++;
        }
      }
    }
    console.log(`  ✓ ${poCount} PO→GRNI cycles, ${inv} item invoices, ${pay} payments`);

    // ── Deliveries in every state, through the REAL flow so the ledger ties ──
    const riderFlow = async (
      deliveryId: string, riderId: string, statuses: string[],
    ) => {
      for (const st of statuses) {
        await deliveries.updateStatus(cid, deliveryId, { status: st } as any, riderId, 'delivery');
      }
    };
    const submitPod = async (
      deliveryId: string, riderId: string, paidStatus: 'paid' | 'unpaid',
      changes: Array<{ itemId: string; itemName: string; beforeQty: number; deliveredQty: number; returnedQty: number }>,
    ) => {
      const res = await approvals.submitBillPhoto(
        cid, deliveryId, riderId, 'Rider',
        { buffer: PNG, mimetype: 'image/png', originalname: 'bill.png', size: PNG.length } as any,
        { changes: JSON.stringify(changes), signedBy: 'Customer', source: 'camera', paidStatus } as any,
      );
      return (res as any)?.requestId ?? (res as any)?.data?.requestId;
    };
    const mkDelivery = (custIdx: number, item: InventoryItem, qty: number, riderId: string | null) =>
      deliveries.create(cid, {
        customerId: customers[custIdx].id, customerName: customers[custIdx].name,
        personnelId: riderId ?? undefined,
        items: [{ itemId: item.id, itemName: item.name, orderedQty: qty, unitPrice: Number(item.sellingPrice), taxRate: 17 }],
      } as any, uid);

    // 1) delivered + PAID → Dr Cash / Cr Sales+Tax, COGS, GIT → 0
    const d1 = await mkDelivery(0, items[0], 3, riderIds[0]);
    await riderFlow((d1 as any).id, riderIds[0], ['picked_up', 'in_transit', 'arrived']);
    const req1 = await submitPod((d1 as any).id, riderIds[0], 'paid', [
      { itemId: items[0].id, itemName: items[0].name, beforeQty: 0, deliveredQty: 3, returnedQty: 0 },
    ]);
    await approvals.approve(cid, req1, {} as any, uid);

    // 2) delivered + UNPAID → open invoice in A/R aging
    const d2 = await mkDelivery(1, items[1], 4, riderIds[1]);
    await riderFlow((d2 as any).id, riderIds[1], ['picked_up', 'in_transit', 'arrived']);
    const req2 = await submitPod((d2 as any).id, riderIds[1], 'unpaid', [
      { itemId: items[1].id, itemName: items[1].name, beforeQty: 0, deliveredQty: 4, returnedQty: 0 },
    ]);
    await approvals.approve(cid, req2, {} as any, uid);

    // 3) returned → Dr Inventory / Cr GIT, restocked, NO revenue
    const d3 = await mkDelivery(2, items[2], 2, riderIds[0]);
    await riderFlow((d3 as any).id, riderIds[0], ['picked_up']);
    await deliveries.updateStatus(cid, (d3 as any).id, { status: 'returned', notes: 'Customer refused' } as any, uid, 'admin');

    // 4) in transit → value parked in Goods in Transit (correctly non-zero)
    const d4 = await mkDelivery(3, items[3], 3, riderIds[1]);
    await riderFlow((d4 as any).id, riderIds[1], ['picked_up', 'in_transit']);

    // 5) freshly assigned
    await mkDelivery(0, items[1], 2, riderIds[0]);

    console.log('  ✓ deliveries: delivered+paid, delivered+unpaid, returned, in-transit, assigned');

    // ── The core ties ──
    const gitRows = await ds.query(
      `SELECT COALESCE(SUM(g.debit - g.credit),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND a.account_number='1250'`,
      [cid],
    );
    const gitBalance = Number(gitRows[0]?.v ?? 0);
    const inTransitRows = await ds.query(
      `SELECT COALESCE(SUM(di.ordered_qty::numeric * di.unit_cost::numeric),0) AS v
         FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
        WHERE d.company_id=$1 AND d.ledger_status = 'in_transit'`,
      [cid],
    );
    const inTransitCost = Number(inTransitRows[0]?.v ?? 0);
    const gitOk = Math.abs(gitBalance - inTransitCost) < 0.01;
    if (!gitOk) tieFailures++;
    console.log(`  ${gitOk ? '✓' : '✗'} Goods in Transit (${gitBalance}) = in-transit deliveries' cost (${inTransitCost}) — nets to ZERO for completed`);

    const val = await reports.inventoryValuation(cid);
    const gl1200 = await ds.query(
      `SELECT COALESCE(SUM(g.debit - g.credit),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND a.account_number='1200'`,
      [cid],
    );
    const valOk = Math.abs(Number((val as any)?.totalValue ?? 0) - Number(gl1200[0]?.v ?? 0)) < 0.01;
    if (!valOk) tieFailures++;
    console.log(`  ${valOk ? '✓' : '✗'} Inventory Valuation (${(val as any)?.totalValue}) ties to GL 1200 (${gl1200[0]?.v})`);

    await assertBooks('Warehouse Co', cid);
  }

  console.log(`\n${tieFailures === 0 ? '✓ ALL TIES HOLD' : `✗ ${tieFailures} TIE FAILURES`} — demo companies ready.`);
  console.log('  Sukoon        sukoon@gmail.com / 123456        (small business)');
  console.log('  MetroMatrix   metromatrix@gmail.com / 123456   (large organization)');
  console.log('  Warehouse Co  warehouse@gmail.com / 123456     (warehouse)');
  console.log('  Riders        rider1@warehouseco.com, rider2@warehouseco.com / 123456');
  await app.close();
  process.exit(tieFailures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('SEED FAILED:', e);
  process.exit(1);
});
