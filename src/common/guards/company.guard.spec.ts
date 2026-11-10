import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
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

  const run = async (
    user: Partial<AuthenticatedUser>,
    row: Record<string, unknown> | null,
  ) => {
    const query = jest.fn().mockResolvedValue(row ? [row] : []);
    const guard = new CompanyGuard({ query } as unknown as DataSource);
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
});
