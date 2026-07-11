import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { RevokedAccessToken } from './entities/revoked-access-token.entity';
import { EmailVerification } from './entities/email-verification.entity';
import { PasswordResetOtp } from './entities/password-reset-otp.entity';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function repoMock() {
  return {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => x),
    update: jest.fn(async () => ({ affected: 1 })),
  };
}

function revokedRepoMock() {
  const insertExecute = jest.fn(async () => ({}));
  return {
    exists: jest.fn(async () => false),
    delete: jest.fn(async () => ({ affected: 0 })),
    createQueryBuilder: jest.fn(() => ({
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: insertExecute,
    })),
    insertExecute,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let users: { findByEmail: jest.Mock; getByIdOrFail: jest.Mock; save: jest.Mock };
  let verificationRepo: ReturnType<typeof repoMock>;
  let otpRepo: ReturnType<typeof repoMock>;
  let refreshRepo: ReturnType<typeof repoMock>;
  let revokedRepo: ReturnType<typeof revokedRepoMock>;
  let jwtMock: { signAsync: jest.Mock; decode: jest.Mock; verify: jest.Mock };
  let mail: {
    sendVerificationEmail: jest.Mock;
    sendOtpEmail: jest.Mock;
  };

  beforeEach(async () => {
    users = {
      findByEmail: jest.fn(),
      getByIdOrFail: jest.fn(),
      save: jest.fn(async (u) => u),
    };
    verificationRepo = repoMock();
    otpRepo = repoMock();
    refreshRepo = repoMock();
    revokedRepo = revokedRepoMock();
    jwtMock = { signAsync: jest.fn(), decode: jest.fn(), verify: jest.fn() };
    mail = {
      sendVerificationEmail: jest.fn(),
      sendOtpEmail: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwtMock },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string, d?: unknown) => {
              const map: Record<string, unknown> = {
                'app.bcryptCost': 4,
                'mail.otpTtlMinutes': 10,
                'mail.otpMaxAttempts': 5,
                'mail.verificationTtlHours': 24,
              };
              return map[k] ?? d;
            }),
            getOrThrow: jest.fn(() => 'secret'),
          },
        },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: MailService, useValue: mail },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshRepo },
        { provide: getRepositoryToken(RevokedAccessToken), useValue: revokedRepo },
        { provide: getRepositoryToken(EmailVerification), useValue: verificationRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: otpRepo },
        { provide: getRepositoryToken(Company), useValue: repoMock() },
        { provide: getRepositoryToken(UserCompany), useValue: repoMock() },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('signin gate', () => {
    it('rejects unknown user with generic message', async () => {
      users.findByEmail.mockResolvedValue(null);
      await expect(
        service.signin({ email: 'x@y.z', password: 'pw' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('blocks an unverified company admin from signing in', async () => {
      const passwordHash = await bcrypt.hash('Admin123!', 4);
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'admin@x.z',
        passwordHash,
        role: 'admin',
        isActive: true,
        isEmailVerified: false,
      });
      await expect(
        service.signin({ email: 'admin@x.z', password: 'Admin123!' }),
      ).rejects.toMatchObject({ response: { code: 'EMAIL_NOT_VERIFIED' } });
    });
  });

  describe('verifyEmail', () => {
    it('throws on an unknown/expired token', async () => {
      verificationRepo.findOne.mockResolvedValue(null);
      await expect(service.verifyEmail('bad')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks the user verified and consumes the token', async () => {
      const token = 'good-token';
      verificationRepo.findOne.mockResolvedValue({
        userId: 'u1',
        tokenHash: sha(token),
        usedAt: null,
        expiresAt: new Date(Date.now() + 100000),
      });
      const user = { id: 'u1', email: 'a@b.c', isEmailVerified: false };
      users.getByIdOrFail.mockResolvedValue(user);
      const res = await service.verifyEmail(token);
      expect(res.verified).toBe(true);
      expect(user.isEmailVerified).toBe(true);
      expect(verificationRepo.save).toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    it('does not reveal that an email is unknown', async () => {
      users.findByEmail.mockResolvedValue(null);
      const res = await service.forgotPassword({ email: 'nobody@x.z' });
      expect(res).toEqual({ delivered: true });
      expect(mail.sendOtpEmail).not.toHaveBeenCalled();
    });

    it('issues and emails an OTP for a known user', async () => {
      users.findByEmail.mockResolvedValue({ id: 'u1', email: 'a@b.c', displayName: 'A' });
      const res = await service.forgotPassword({ email: 'a@b.c' });
      expect(res).toEqual({ delivered: true });
      expect(otpRepo.save).toHaveBeenCalled();
      expect(mail.sendOtpEmail).toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('locks out after too many attempts', async () => {
      users.findByEmail.mockResolvedValue({ id: 'u1', email: 'a@b.c' });
      otpRepo.findOne.mockResolvedValue({
        userId: 'u1',
        otpHash: sha('111111'),
        attempts: 5,
        expiresAt: new Date(Date.now() + 100000),
        usedAt: null,
      });
      await expect(
        service.verifyOtp({ email: 'a@b.c', otp: '111111' }),
      ).rejects.toMatchObject({ response: { code: 'OTP_LOCKED' } });
    });

    it('increments attempts on a wrong code', async () => {
      users.findByEmail.mockResolvedValue({ id: 'u1', email: 'a@b.c' });
      const record = {
        userId: 'u1',
        otpHash: sha('111111'),
        attempts: 0,
        expiresAt: new Date(Date.now() + 100000),
        usedAt: null,
      };
      otpRepo.findOne.mockResolvedValue(record);
      await expect(
        service.verifyOtp({ email: 'a@b.c', otp: '999999' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(record.attempts).toBe(1);
    });

    it('returns a reset token on the correct code', async () => {
      users.findByEmail.mockResolvedValue({ id: 'u1', email: 'a@b.c' });
      otpRepo.findOne.mockResolvedValue({
        userId: 'u1',
        otpHash: sha('123456'),
        attempts: 0,
        expiresAt: new Date(Date.now() + 100000),
        usedAt: null,
        verifiedAt: null,
        resetTokenHash: null,
      });
      const res = await service.verifyOtp({ email: 'a@b.c', otp: '123456' });
      expect(typeof res.resetToken).toBe('string');
      expect(res.resetToken.length).toBeGreaterThan(10);
    });
  });

  describe('signoutByToken (POST /auth/logout)', () => {
    const exp = Math.floor(Date.now() / 1000) + 900;

    it.each(['admin', 'super_admin', 'delivery'] as const)(
      'revokes refresh tokens and denylists the access jti for role %s',
      async (role) => {
        jwtMock.verify.mockReturnValue({
          sub: 'u1',
          companyId: role === 'super_admin' ? null : 'c1',
          role,
          jti: `jti-${role}`,
          exp,
        });
        const res = await service.signoutByToken('Bearer some.valid.token');
        expect(res).toEqual({ success: true, message: 'Signed out' });
        // All active refresh tokens revoked for the user…
        expect(refreshRepo.update).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'u1' }),
          expect.objectContaining({ revokedAt: expect.any(Date) }),
        );
        // …and the access token's jti denylisted with its expiry.
        expect(revokedRepo.insertExecute).toHaveBeenCalled();
        const qb = revokedRepo.createQueryBuilder.mock.results[0].value;
        expect(qb.values).toHaveBeenCalledWith({
          jti: `jti-${role}`,
          userId: 'u1',
          expiresAt: new Date(exp * 1000),
        });
      },
    );

    it('is idempotent: an invalid/expired token still returns success and reveals nothing', async () => {
      jwtMock.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });
      const res = await service.signoutByToken('Bearer expired.token');
      expect(res).toEqual({ success: true, message: 'Signed out' });
      expect(refreshRepo.update).not.toHaveBeenCalled();
      expect(revokedRepo.insertExecute).not.toHaveBeenCalled();
    });

    it('handles a missing Authorization header as a no-op success', async () => {
      const res = await service.signoutByToken(undefined);
      expect(res).toEqual({ success: true, message: 'Signed out' });
      expect(jwtMock.verify).not.toHaveBeenCalled();
      expect(refreshRepo.update).not.toHaveBeenCalled();
    });

    it('still revokes refresh tokens for a valid pre-jti token (no jti claim)', async () => {
      jwtMock.verify.mockReturnValue({ sub: 'u1', companyId: 'c1', role: 'admin', exp });
      const res = await service.signoutByToken('Bearer legacy.token');
      expect(res.success).toBe(true);
      expect(refreshRepo.update).toHaveBeenCalled();
      expect(revokedRepo.insertExecute).not.toHaveBeenCalled();
    });

    it('prunes expired denylist rows opportunistically', async () => {
      jwtMock.verify.mockReturnValue({ sub: 'u1', companyId: 'c1', role: 'admin', jti: 'j1', exp });
      await service.signoutByToken('Bearer some.valid.token');
      expect(revokedRepo.delete).toHaveBeenCalled();
    });
  });

  describe('isAccessTokenRevoked', () => {
    it('reflects the denylist (guard rejects a signed-out token with 401)', async () => {
      revokedRepo.exists.mockResolvedValueOnce(true);
      await expect(service.isAccessTokenRevoked('j1')).resolves.toBe(true);
      revokedRepo.exists.mockResolvedValueOnce(false);
      await expect(service.isAccessTokenRevoked('j2')).resolves.toBe(false);
    });
  });
});
