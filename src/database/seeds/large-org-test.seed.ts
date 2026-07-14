/**
 * One-off: create a LARGE ORGANIZATION test company so the tier gating can
 * be verified in the app. Mirrors tier-demos.seed.ts ensureCompany but only
 * creates the company + admin (COA seeded by the real CompaniesService).
 *
 *   LARGE ORG  "LargeOrg Test Co"  largeorg@gmail.com / 123456  (large_org_6mo)
 *
 * Idempotent: safe to re-run; touches ONLY this company/user.
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
import { CompaniesService } from '../../modules/companies/companies.service';
import { getPlanConfig } from '../../modules/billing/plan-config';

loadEnv();

const NAME = 'LargeOrg Test Co';
const EMAIL = 'largeorg@gmail.com';
const PASSWORD = '123456';
const PLAN = 'large_org_6mo' as const;

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const companiesSvc = app.get(CompaniesService);

  const userRepo = ds.getRepository(User);
  let admin = await userRepo.findOne({ where: { email: EMAIL } });
  const hash = await bcrypt.hash(PASSWORD, 12);
  if (!admin) {
    admin = userRepo.create({
      email: EMAIL,
      passwordHash: hash,
      displayName: 'LargeOrg Admin',
      phone: '+92-300-7770002',
      role: 'admin',
      isActive: true,
      isEmailVerified: true,
    } as Partial<User>);
  } else {
    admin.passwordHash = hash;
    admin.isActive = true;
    (admin as any).role = 'admin';
    (admin as any).isEmailVerified = true;
  }
  admin = await userRepo.save(admin);

  const companyRepo = ds.getRepository(Company);
  let company = await companyRepo.findOne({ where: { name: NAME } });
  if (!company) {
    // Real service call: seeds the chart of accounts + membership too.
    company = await companiesSvc.create(admin.id, {
      name: NAME,
      industry: 'Professional Services',
      companyType: 'large_org',
    } as any);
  }

  const ucRepo = ds.getRepository(UserCompany);
  const membership = await ucRepo.findOne({
    where: { userId: admin.id, companyId: company.id },
  });
  if (!membership) {
    await ucRepo.save(ucRepo.create({ userId: admin.id, companyId: company.id, role: 'admin' }));
  }
  if (!admin.defaultCompanyId) {
    admin.defaultCompanyId = company.id;
    await userRepo.save(admin);
  }

  const cfg = getPlanConfig(PLAN);
  const start = new Date();
  const expiry = new Date(start);
  expiry.setMonth(expiry.getMonth() + (cfg.durationMonths ?? 6));
  await ds.query(
    `UPDATE companies SET
       company_type='large_org', inventory_enabled=false, all_features_unlocked=false,
       subscription_plan=$2, subscription_status='active',
       subscription_start_date=$3, subscription_expiry_date=$4,
       payment_status='paid', status='approved', setup_completed=true
     WHERE id=$1`,
    [company.id, PLAN, start, expiry],
  );

  console.log(`OK: ${NAME} (${company.id}) admin ${EMAIL} / ${PASSWORD} — large_org, approved, active ${PLAN}`);
  await app.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
