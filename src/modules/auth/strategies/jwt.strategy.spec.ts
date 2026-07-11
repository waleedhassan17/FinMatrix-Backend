import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtStrategy, JwtPayload } from './jwt.strategy';
import { UsersService } from '../../users/users.service';
import { RevokedAccessToken } from '../entities/revoked-access-token.entity';

describe('JwtStrategy (signout denylist)', () => {
  let strategy: JwtStrategy;
  let users: { findById: jest.Mock };
  let revokedRepo: { exists: jest.Mock };

  const activeUser = { id: 'u1', email: 'a@b.c', isActive: true };
  const payload = (over: Partial<JwtPayload> = {}): JwtPayload => ({
    sub: 'u1',
    companyId: 'c1',
    role: 'admin',
    jti: 'jti-1',
    ...over,
  });

  beforeEach(async () => {
    users = { findById: jest.fn(async () => activeUser) };
    revokedRepo = { exists: jest.fn(async () => false) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: UsersService, useValue: users },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn(() => 'secret') } },
        { provide: getRepositoryToken(RevokedAccessToken), useValue: revokedRepo },
      ],
    }).compile();

    strategy = moduleRef.get(JwtStrategy);
  });

  it('accepts a token whose jti is not denylisted', async () => {
    await expect(strategy.validate(payload())).resolves.toMatchObject({ id: 'u1' });
  });

  it('rejects a signed-out (denylisted) token with 401', async () => {
    revokedRepo.exists.mockResolvedValue(true);
    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
    // users lookup must not even run for a revoked token
    expect(users.findById).not.toHaveBeenCalled();
  });

  it.each(['admin', 'super_admin', 'delivery'] as const)(
    'the denylist applies identically for role %s',
    async (role) => {
      revokedRepo.exists.mockResolvedValue(true);
      await expect(strategy.validate(payload({ role }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('skips the denylist check for legacy tokens without a jti', async () => {
    await expect(strategy.validate(payload({ jti: undefined }))).resolves.toMatchObject({
      id: 'u1',
    });
    expect(revokedRepo.exists).not.toHaveBeenCalled();
  });

  it('still rejects inactive users', async () => {
    users.findById.mockResolvedValue({ ...activeUser, isActive: false });
    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
