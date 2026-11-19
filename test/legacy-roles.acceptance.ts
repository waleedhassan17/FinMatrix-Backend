/**
 * Charts written by the release from before system roles (see
 * src/modules/accounts/legacy-roles.util.ts).
 *
 * While a deploy rolls out, the older release still serves for a few
 * minutes after migration 1791100000000 ran, and it knows nothing of
 * accounts.system_role: a company it creates has a chart with no role at all,
 * and a system account it adds on first need (Customer Advances, Opening
 * Balance Equity…) has none either. These checks prove the new release heals
 * both on first use and in its sweep, never adopts an owner's own account on
 * its number alone, and stays correct when two requests heal at once.
 *
 * Runs in-process against the database in the DB_* variables, like the other
 * harness suites:  npm run test:legacy-roles
 */
import './migration-harness.env';
import { bootHarness, freshCompany } from './migration-harness';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  SYS,
} from '../src/modules/accounts/accounts.constants';
import { AccountsService } from '../src/modules/accounts/accounts.service';
import { healLegacyCharts } from '../src/modules/accounts/legacy-roles.util';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : ''}`,
    );
  }
};

/** Roles the default chart seeds (Customer Advances is added on first need). */
const SEEDED = DEFAULT_CHART_OF_ACCOUNTS.filter((a) => a.systemRole).map(
  (a) => [a.systemRole!, a.accountNumber] as const,
);

async function main() {
  const h = await bootHarness();
  const accounts = h.app.get(AccountsService);
  const t0 = Date.now();

  type Row = { number: string; name: string; role: string | null };
  const chart = async (companyId: string): Promise<Row[]> =>
    h.ds.query(
      `SELECT account_number AS number, name, system_role AS role FROM accounts WHERE company_id = $1 ORDER BY account_number`,
      [companyId],
    );
  const roleAt = (rows: Row[], role: string) =>
    rows.filter((r) => r.role === role).map((r) => r.number);
  /** A company the older release created: its chart has no role at all. */
  const olderReleaseCompany = async (label: string) => {
    const c = await freshCompany(h.ds, `legacy-${label}-${Date.now()}`);
    await h.ds.query(
      `UPDATE accounts SET system_role = NULL WHERE company_id = $1`,
      [c.companyId],
    );
    return c;
  };

  try {
    console.log(
      '\n── a chart with no role at all takes them on first use, as the migration gave them',
    );
    {
      const { companyId } = await olderReleaseCompany('first-use');
      // The older release let an owner rename any account; the number was
      // how it found a system account, so a renamed bank is still the bank.
      await h.ds.query(
        `UPDATE accounts SET name = 'Meezan Bank' WHERE company_id = $1 AND account_number = '1010'`,
        [companyId],
      );
      const ar = await accounts.getSystemAccount(companyId, SYS.AR);
      ok(
        'Receivables is found: the account at 1100',
        ar.accountNumber === '1100',
        ar,
      );
      const rows = await chart(companyId);
      const wrong = SEEDED.filter(
        ([role, number]) =>
          JSON.stringify(roleAt(rows, role)) !== JSON.stringify([number]),
      );
      ok(
        `every system account took its role, once (${SEEDED.length})`,
        wrong.length === 0,
        wrong,
      );
      ok(
        'the renamed bank is still the bank',
        JSON.stringify(roleAt(rows, SYS.BANK)) === '["1010"]',
        rows.find((r) => r.number === '1010'),
      );
      ok(
        'healing again changes nothing',
        (await healLegacyCharts(h.ds.manager, [companyId])) === 0,
      );
    }

    console.log(
      '\n── posting on such a chart uses its own accounts, never a second copy',
    );
    {
      const { companyId, user } = await olderReleaseCompany('posting');
      const petty = await accounts.create(
        companyId,
        {
          accountNumber: '1020',
          name: 'Petty Cash Drawer',
          type: 'asset',
          subType: 'Cash',
          openingBalance: '500',
        } as any,
        user.id,
      );
      const posted: Array<{ number: string; debit: string; credit: string }> =
        await h.ds.query(
          `SELECT a.account_number AS number, g.debit::text AS debit, g.credit::text AS credit
             FROM general_ledger g JOIN accounts a ON a.id = g.account_id
            WHERE g.company_id = $1 ORDER BY a.account_number`,
          [companyId],
        );
      ok(
        'the opening balance posts against the chart’s own 3900 Opening Balance Equity',
        posted.length === 2 &&
          posted[0].number === '1020' &&
          posted[1].number === '3900' &&
          Number(posted[0].debit) === 500 &&
          Number(posted[1].credit) === 500,
        posted,
      );
      const rows = await chart(companyId);
      ok(
        'no second Opening Balance Equity was created',
        rows.filter((r) => /opening balance equity/i.test(r.name)).length ===
          1 &&
          JSON.stringify(roleAt(rows, SYS.OPENING_BALANCE_EQUITY)) ===
            '["3900"]',
        rows.filter((r) => r.number.startsWith('39')),
      );
      ok(
        'the new account holds no role',
        rows.find((r) => r.number === '1020')?.role === null,
        petty,
      );
    }

    console.log(
      '\n── a system account the older release added without its role takes it',
    );
    {
      const { companyId } = await freshCompany(
        h.ds,
        `legacy-added-${Date.now()}`,
      );
      await h.ds.query(
        `INSERT INTO accounts (company_id, account_number, name, type, sub_type, opening_balance, balance, is_active)
         VALUES ($1, '2400', 'Customer Advances (Unearned Revenue)', 'liability', 'Other Liability', 0, 0, true)`,
        [companyId],
      );
      const advances = await h.ds.transaction((m) =>
        accounts.getOrCreateSystemAccount(m, companyId, SYS.CUSTOMER_ADVANCES),
      );
      const rows = await chart(companyId);
      ok(
        'Customer Advances is the 2400 the older release added',
        advances.accountNumber === '2400' &&
          JSON.stringify(roleAt(rows, SYS.CUSTOMER_ADVANCES)) === '["2400"]',
        advances,
      );
      ok(
        'no second Customer Advances (2401) was created',
        !rows.some((r) => r.number === '2401'),
        rows.filter((r) => r.number.startsWith('24')),
      );
    }

    console.log(
      '\n── an owner’s own account on a default number is never adopted on its number',
    );
    {
      const { companyId } = await freshCompany(
        h.ds,
        `legacy-owner-${Date.now()}`,
      );
      // A migrating owner's chart: 2050 is their Accrued Wages, and the
      // company has no GRNI account yet.
      await h.ds.query(
        `UPDATE accounts SET system_role = NULL, name = 'Accrued Wages' WHERE company_id = $1 AND system_role = 'grni'`,
        [companyId],
      );
      const grni = await h.ds.transaction((m) =>
        accounts.getOrCreateSystemAccount(m, companyId, SYS.GRNI),
      );
      const rows = await chart(companyId);
      ok(
        'GRNI is created on the next free number (2051), with its own name',
        grni.accountNumber === '2051' &&
          grni.name === 'Inventory Received Not Billed (GRNI)',
        grni,
      );
      ok(
        'the owner’s 2050 Accrued Wages keeps no role',
        rows.find((r) => r.number === '2050')?.role === null,
        rows.find((r) => r.number === '2050'),
      );
    }

    console.log(
      '\n── on a chart with no roles, an account of another type is not adopted',
    );
    {
      const { companyId } = await olderReleaseCompany('type');
      await h.ds.query(
        `UPDATE accounts SET type = 'expense', sub_type = 'Operating', name = 'Bad Debts' WHERE company_id = $1 AND account_number = '1100'`,
        [companyId],
      );
      await healLegacyCharts(h.ds.manager, [companyId]);
      const rows = await chart(companyId);
      ok(
        '1100 Bad Debts (an expense) did not become Receivables',
        rows.find((r) => r.number === '1100')?.role === null &&
          roleAt(rows, SYS.AR).length === 0,
        rows.find((r) => r.number === '1100'),
      );
      ok(
        'the rest of the chart took its roles',
        roleAt(rows, SYS.CASH)[0] === '1000' &&
          roleAt(rows, SYS.SALES_REVENUE)[0] === '4000',
      );
    }

    console.log(
      '\n── the sweep heals every chart without roles and leaves the others exactly as they were',
    );
    {
      const legacy = await olderReleaseCompany('sweep');
      const current = await freshCompany(h.ds, `legacy-kept-${Date.now()}`);
      // A chart this release wrote, with a renumbered system account and an
      // owner account on a freed default number: nothing about it may change.
      await h.ds.query(
        `UPDATE accounts SET account_number = '11000' WHERE company_id = $1 AND system_role = 'accounts_receivable'`,
        [current.companyId],
      );
      await h.ds.query(
        `INSERT INTO accounts (company_id, account_number, name, type, sub_type, opening_balance, balance, is_active)
         VALUES ($1, '1100', 'Accounts Receivable', 'asset', 'Accounts Receivable', 0, 0, true)`,
        [current.companyId],
      );
      const kept = await chart(current.companyId);
      const healed = await healLegacyCharts(h.ds.manager);
      const rows = await chart(legacy.companyId);
      ok(
        `the chart without roles took all ${SEEDED.length}`,
        healed >= SEEDED.length &&
          SEEDED.every(([role, n]) => roleAt(rows, role)[0] === n),
        healed,
      );
      ok(
        'the chart with roles is untouched (its 1100 stays the owner’s own)',
        JSON.stringify(await chart(current.companyId)) === JSON.stringify(kept),
      );
    }

    console.log(
      '\n── two requests healing one chart at once: both succeed, one account per role',
    );
    {
      const { companyId } = await olderReleaseCompany('race');
      const [ar, cash, tax] = await Promise.all([
        h.ds.transaction((m) =>
          accounts.getSystemAccount(companyId, SYS.AR, m),
        ),
        h.ds.transaction((m) =>
          accounts.getOrCreateSystemAccount(m, companyId, SYS.CASH),
        ),
        accounts.getSystemAccount(companyId, SYS.TAX_PAYABLE),
      ]);
      ok(
        'each found its account (1100, 1000, 2300)',
        ar.accountNumber === '1100' &&
          cash.accountNumber === '1000' &&
          tax.accountNumber === '2300',
        [ar.accountNumber, cash.accountNumber, tax.accountNumber],
      );
      const rows = await chart(companyId);
      const dup = SEEDED.filter(([role]) => roleAt(rows, role).length !== 1);
      ok(
        'every role is held by exactly one account',
        dup.length === 0 && rows.length === DEFAULT_CHART_OF_ACCOUNTS.length,
        { dup, accounts: rows.length },
      );
    }
  } finally {
    await h.close();
  }
  console.log(
    `\n${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  if (fail) {
    console.log('Failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
