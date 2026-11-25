import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AllowWhenLapsed } from '../decorators/allow-when-lapsed.decorator';
import { CompanyGuard } from './company.guard';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * The token names a company and a role as they were when it was issued.
 * CompanyGuard is where both are checked against the database on every
 * request, so a removed member or a demoted admin loses that access at once.
 */
describe('CompanyGuard', () => {
  const activeCompany = {
    status: 'active',
    subscription_plan: null,
    subscription_expiry_date: null,
  };

  class Routes {
    @AllowWhenLapsed()
    backup() {}
    commit() {}
  }

  const run = async (
    user: Partial<AuthenticatedUser>,
    row: Record<string, unknown> | null,
    handler?: 'backup' | 'commit',
  ) => {
    const query = jest.fn().mockResolvedValue(row ? [row] : []);
    const guard = new CompanyGuard(
      { query } as unknown as DataSource,
      handler ? new Reflector() : undefined,
    );
    const req: { user: AuthenticatedUser; companyId?: string | null } = {
      user: {
        id: 'u1',
        email: 'a@b.c',
        username: null,
        role: 'admin',
        companyId: 'c1',
        ...user,
      } as AuthenticatedUser,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () =>
        handler ? Routes.prototype[handler] : Routes.prototype.commit,
      getClass: () => Routes,
    } as unknown as ExecutionContext;
    const result = await guard.canActivate(ctx);
    return { result, req, query };
  };

  it('admits a current member and attaches the company', async () => {
    const { result, req } = await run(
      {},
      { ...activeCompany, member_role: 'admin' },
    );
    expect(result).toBe(true);
    expect(req.companyId).toBe('c1');
  });

  it('refuses a user who has been removed from the company', async () => {
    await expect(
      run({}, { ...activeCompany, member_role: null }),
    ).rejects.toMatchObject({
      response: { code: 'NOT_COMPANY_MEMBER' },
    });
  });

  it('replaces the role in the token with the role held now', async () => {
    const { req } = await run(
      { role: 'admin' },
      { ...activeCompany, member_role: 'staff' },
    );
    expect(req.user.role).toBe('staff');
  });

  it('checks membership in the same single query, for riders too', async () => {
    const { query } = await run(
      { role: 'delivery' },
      { ...activeCompany, member_role: 'delivery', rider_status: 'active' },
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('user_companies');
    expect(query.mock.calls[0][1]).toEqual(['c1', 'u1']);
  });

  it('still refuses a company that is not active', async () => {
    await expect(
      run({}, { ...activeCompany, status: 'inactive', member_role: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a token with no company', async () => {
    await expect(run({ companyId: null }, null)).rejects.toMatchObject({
      response: { code: 'NOT_COMPANY_MEMBER' },
    });
  });

  // ── Launch: deletion, suspension, lapsed trials ────────────────────────

  const ended = {
    status: 'inactive',
    subscription_plan: 'warehouse_trial',
    subscription_expiry_date: new Date(Date.now() - 60_000),
    subscription_status: 'expired',
    is_trial: true,
    trial_converted_at: null,
    suspended_at: null,
  };

  it('refuses a token naming a company that no longer exists', async () => {
    await expect(run({}, null)).rejects.toMatchObject({
      response: { code: 'NOT_COMPANY_MEMBER' },
    });
  });

  it('refuses every member of a suspended company, even on whitelisted routes', async () => {
    await expect(
      run(
        {},
        { ...activeCompany, suspended_at: new Date(), member_role: 'admin' },
        'backup',
      ),
    ).rejects.toMatchObject({ response: { code: 'COMPANY_SUSPENDED' } });
  });

  it('answers TRIAL_ENDED once the trial lapses (live, before any cron)', async () => {
    const live = {
      ...ended,
      status: 'active',
      subscription_status: 'active',
    };
    await expect(
      run({}, { ...live, member_role: 'admin' }),
    ).rejects.toMatchObject({
      response: { code: 'TRIAL_ENDED', audience: 'owner' },
    });
  });

  it('tells staff and riders to contact the owner', async () => {
    await expect(
      run({ role: 'staff' }, { ...ended, member_role: 'staff' }, 'backup'),
    ).rejects.toMatchObject({
      response: {
        code: 'TRIAL_ENDED',
        audience: 'member',
        message: "Your company's trial has ended — please contact the owner.",
      },
    });
  });

  it('lets the OWNER of an ended trial reach a whitelisted route only', async () => {
    const ok = await run({}, { ...ended, member_role: 'admin' }, 'backup');
    expect(ok.result).toBe(true);
    await expect(
      run({}, { ...ended, member_role: 'admin' }, 'commit'),
    ).rejects.toMatchObject({ response: { code: 'TRIAL_ENDED' } });
  });

  it('answers SUBSCRIPTION_EXPIRED for a paid plan that lapsed', async () => {
    await expect(
      run(
        {},
        {
          ...ended,
          is_trial: false,
          subscription_plan: 'warehouse_starter_6mo',
          member_role: 'admin',
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'SUBSCRIPTION_EXPIRED' } });
  });

  it('a deactivated (not lapsed) company stays COMPANY_NOT_ACTIVE', async () => {
    await expect(
      run(
        {},
        { ...activeCompany, status: 'inactive', member_role: 'admin' },
        'backup',
      ),
    ).rejects.toMatchObject({ response: { code: 'COMPANY_NOT_ACTIVE' } });
  });
});
