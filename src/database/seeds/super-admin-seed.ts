/**
 * Super Admin Seed Script
 * Creates super admin user, subscription plans, demo companies and subscriptions.
 *
 * Usage (dev):   npm run seed:superadmin
 * Usage (prod):  npm run seed:superadmin:prod
 *
 * Credentials seeded:
 *   Super Admin: waleedhassansfd@gmail.com / 123456
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { User } from '../../modules/users/entities/user.entity';
import { Company } from '../../modules/companies/entities/company.entity';
import { UserCompany } from '../../modules/companies/entities/user-company.entity';
import { SubscriptionPlan } from '../../modules/super-admin/entities/subscription-plan.entity';
import { CompanySubscription } from '../../modules/super-admin/entities/company-subscription.entity';
import { generateInviteCode } from '../../common/utils/reference-generator.util';

loadEnv();

// ── Helper ────────────────────────────────────────────
function randCode() {
  return generateInviteCode(6);
}

async function run() {
  const isProduction = process.env.NODE_ENV === 'production';

  const ds = new DataSource(
    process.env.DATABASE_URL
      ? {
          type: 'postgres',
          url: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          entities: [User, Company, UserCompany, SubscriptionPlan, CompanySubscription],
          synchronize: true,
        }
      : {
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: parseInt(process.env.DB_PORT ?? '5432', 10),
          username: process.env.DB_USERNAME ?? 'finmatrix_user',
          password: process.env.DB_PASSWORD ?? '',
          database: process.env.DB_NAME ?? 'finmatrix',
          ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
          entities: [User, Company, UserCompany, SubscriptionPlan, CompanySubscription],
          synchronize: true,
        },
  );

  await ds.initialize();
  console.log('✔ Connected. Running super-admin seed…');

  await ds.transaction(async (m) => {
    // ── 1. Super Admin User ───────────────────────────
    const SUPER_ADMIN_EMAIL = 'waleedhassansfd@gmail.com';
    const SUPER_ADMIN_PASS = '123456';

    let superAdmin = await m.findOneBy(User, { email: SUPER_ADMIN_EMAIL });
    if (!superAdmin) {
      const hash = await bcrypt.hash(SUPER_ADMIN_PASS, 12);
      superAdmin = await m.save(
        m.create(User, {
          email: SUPER_ADMIN_EMAIL,
          passwordHash: hash,
          displayName: 'Waleed Hassan',
          phone: '+92-300-1234567',
          role: 'super_admin',
          isActive: true,
          defaultCompanyId: null,
        }),
      );
      console.log(`  ✔ Super admin created: ${SUPER_ADMIN_EMAIL}`);
    } else {
      if (superAdmin.role !== 'super_admin') {
        superAdmin.role = 'super_admin';
        await m.save(superAdmin);
      }
      console.log(`  ↩ Super admin already exists: ${SUPER_ADMIN_EMAIL}`);
    }

    // ── 2. Subscription Plans ─────────────────────────
    const plans: Array<Partial<SubscriptionPlan> & { name: string }> = [
      {
        name: 'Free',
        description: 'Get started with the basics. No credit card required.',
        priceMonthly: '0.00',
        priceYearly: '0.00',
        maxUsers: 2,
        maxInvoices: 10,
        features: ['2 Users', '10 Invoices/month', 'Basic Dashboard', 'Email Support'],
        isActive: true,
        sortOrder: 0,
      },
      {
        name: 'Starter',
        description: 'Perfect for small businesses getting started with digital accounting.',
        priceMonthly: '29.00',
        priceYearly: '290.00',
        maxUsers: 5,
        maxInvoices: 100,
        features: ['Up to 5 Users', '100 Invoices/month', 'Basic Reports', 'Email Support', 'Mobile App'],
        isActive: true,
        sortOrder: 1,
      },
      {
        name: 'Professional',
        description: 'For growing businesses with advanced accounting and team needs.',
        priceMonthly: '79.00',
        priceYearly: '790.00',
        maxUsers: 20,
        maxInvoices: null,
        features: [
          'Up to 20 Users',
          'Unlimited Invoices',
          'Advanced Reports',
          'Priority Support',
          'API Access',
          'Custom Branding',
          'Payroll Module',
        ],
        isActive: true,
        sortOrder: 2,
      },
      {
        name: 'Enterprise',
        description: 'Full-featured platform for large organizations.',
        priceMonthly: '199.00',
        priceYearly: '1990.00',
        maxUsers: 999,
        maxInvoices: null,
        features: [
          'Unlimited Users',
          'Unlimited Everything',
          'White-label Option',
          'Dedicated Account Manager',
          'SLA Guarantee (99.9%)',
          'Custom Integrations',
          'Advanced Audit Logs',
          'Phone Support',
        ],
        isActive: true,
        sortOrder: 3,
      },
    ];

    const savedPlans: Record<string, SubscriptionPlan> = {};
    for (const p of plans) {
      let plan = await m.findOneBy(SubscriptionPlan, { name: p.name });
      if (!plan) {
        plan = await m.save(m.create(SubscriptionPlan, p as any));
        console.log(`  ✔ Plan created: ${p.name}`);
      } else {
        console.log(`  ↩ Plan exists: ${p.name}`);
      }
      savedPlans[p.name] = plan;
    }

    // ── 3. Demo Companies ─────────────────────────────
    const companyDefs: Array<{
      name: string; industry: string; email: string; phone: string;
      status: string; planName: string | null;
      adminEmail: string; adminName: string;
      daysAgo: number;
    }> = [
      { name: 'TechNova Solutions', industry: 'Technology', email: 'admin@technova.com', phone: '+92-21-1234501', status: 'active', planName: 'Professional', adminEmail: 'ali@technova.com', adminName: 'Ali Raza', daysAgo: 60 },
      { name: 'Global Trade Co.', industry: 'Trading', email: 'info@globaltrade.com', phone: '+92-42-1234502', status: 'active', planName: 'Enterprise', adminEmail: 'tariq@globaltrade.com', adminName: 'Tariq Mehmood', daysAgo: 80 },
      { name: 'Metro Retail Group', industry: 'Retail', email: 'ops@metroretail.com', phone: '+92-51-1234503', status: 'active', planName: 'Starter', adminEmail: 'sara@metroretail.com', adminName: 'Sara Ahmed', daysAgo: 45 },
      { name: 'Green Energy Ltd', industry: 'Energy', email: 'info@greenenergy.com', phone: '+92-21-1234504', status: 'pending', planName: null, adminEmail: 'zain@greenenergy.com', adminName: 'Zain Ul Abdin', daysAgo: 4 },
      { name: 'Pacific Foods Corp', industry: 'Food & Beverage', email: 'hr@pacificfoods.com', phone: '+92-61-1234505', status: 'active', planName: 'Professional', adminEmail: 'nadia@pacificfoods.com', adminName: 'Nadia Khan', daysAgo: 110 },
      { name: 'Summit Healthcare', industry: 'Healthcare', email: 'admin@summitcare.com', phone: '+92-42-1234506', status: 'suspended', planName: 'Enterprise', adminEmail: 'hassan@summitcare.com', adminName: 'Hassan Ali', daysAgo: 180 },
      { name: 'Blue Wave Media', industry: 'Media & Marketing', email: 'contact@bluewavemedia.com', phone: '+92-21-1234507', status: 'active', planName: 'Professional', adminEmail: 'farah@bluewavemedia.com', adminName: 'Farah Siddiqui', daysAgo: 22 },
      { name: 'Frontier Logistics', industry: 'Logistics', email: 'info@frontierlogistics.com', phone: '+92-91-1234508', status: 'pending', planName: null, adminEmail: 'khan@frontierlogistics.com', adminName: 'Imran Khan', daysAgo: 2 },
      { name: 'Everest Consulting', industry: 'Consulting', email: 'hello@everestconsulting.com', phone: '+92-42-1234509', status: 'active', planName: 'Starter', adminEmail: 'aisha@everestconsulting.com', adminName: 'Aisha Malik', daysAgo: 90 },
      { name: 'Star Manufacturing', industry: 'Manufacturing', email: 'info@starmfg.com', phone: '+92-41-1234510', status: 'rejected', planName: null, adminEmail: 'usman@starmfg.com', adminName: 'Usman Ghani', daysAgo: 43 },
      { name: 'Digital Dynamics', industry: 'Technology', email: 'contact@digitaldynamics.com', phone: '+92-21-1234511', status: 'pending', planName: null, adminEmail: 'bilal@digitaldynamics.com', adminName: 'Bilal Chaudhry', daysAgo: 1 },
      { name: 'Apex Financial', industry: 'Financial Services', email: 'admin@apexfinancial.com', phone: '+92-21-1234512', status: 'active', planName: 'Enterprise', adminEmail: 'omer@apexfinancial.com', adminName: 'Omer Farooq', daysAgo: 20 },
    ];

    for (const def of companyDefs) {
      // Create / find company admin user
      let adminUser = await m.findOneBy(User, { email: def.adminEmail });
      if (!adminUser) {
        const hash = await bcrypt.hash('Admin123!', 10);
        adminUser = await m.save(
          m.create(User, {
            email: def.adminEmail,
            passwordHash: hash,
            displayName: def.adminName,
            phone: def.phone,
            role: 'admin',
            isActive: true,
            defaultCompanyId: null,
          }),
        );
      }

      // Create / find company
      let company = await m.findOneBy(Company, { name: def.name });
      if (!company) {
        const createdAt = new Date(Date.now() - def.daysAgo * 24 * 60 * 60 * 1000);
        company = m.create(Company, {
          name: def.name,
          industry: def.industry,
          email: def.email,
          phone: def.phone,
          address: { city: 'Lahore', country: 'Pakistan' },
          inviteCode: randCode(),
          createdBy: adminUser.id,
          status: def.status,
          logo: null,
          taxId: null,
          rejectionReason: def.status === 'rejected' ? 'Incomplete documentation provided.' : null,
          reviewedBy: def.status !== 'pending' ? superAdmin.id : null,
          reviewedAt: def.status !== 'pending' ? new Date(Date.now() - (def.daysAgo - 1) * 24 * 60 * 60 * 1000) : null,
        });
        // TypeORM doesn't let you override @CreateDateColumn easily;
        // insert via query builder for the timestamp
        await m.save(company);
        // update createdAt via raw query
        await m.query(
          `UPDATE companies SET created_at = $1 WHERE id = $2`,
          [createdAt.toISOString(), company.id],
        );
        console.log(`  ✔ Company: ${def.name} (${def.status})`);
      } else {
        console.log(`  ↩ Company exists: ${def.name}`);
      }

      // UserCompany membership
      const existing = await m.findOneBy(UserCompany, {
        userId: adminUser.id,
        companyId: company.id,
      });
      if (!existing) {
        await m.save(
          m.create(UserCompany, { userId: adminUser.id, companyId: company.id, role: 'admin' }),
        );
      }
      if (!adminUser.defaultCompanyId) {
        adminUser.defaultCompanyId = company.id;
        await m.save(adminUser);
      }

      // Assign subscription plan
      if (def.planName && savedPlans[def.planName] && def.status === 'active') {
        const existingSub = await m.findOneBy(CompanySubscription, {
          companyId: company.id,
          status: 'active',
        });
        if (!existingSub) {
          await m.save(
            m.create(CompanySubscription, {
              companyId: company.id,
              planId: savedPlans[def.planName].id,
              status: 'active',
              startDate: new Date(Date.now() - (def.daysAgo - 1) * 86400000).toISOString().split('T')[0],
              endDate: new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
              notes: null,
              assignedBy: superAdmin.id,
            }),
          );
          console.log(`    ↳ Subscription: ${def.planName}`);
        }
      } else if (def.status === 'suspended' && def.planName && savedPlans[def.planName]) {
        const existingSub = await m.findOneBy(CompanySubscription, { companyId: company.id });
        if (!existingSub) {
          await m.save(
            m.create(CompanySubscription, {
              companyId: company.id,
              planId: savedPlans[def.planName].id,
              status: 'cancelled',
              startDate: new Date(Date.now() - def.daysAgo * 86400000).toISOString().split('T')[0],
              endDate: null,
              notes: 'Suspended pending payment review.',
              assignedBy: superAdmin.id,
            }),
          );
        }
      }
    }
  });

  await ds.destroy();
  console.log('\n✔ Super admin seed complete!');
  console.log('  Login: waleedhassansfd@gmail.com / 123456');
}

run().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
