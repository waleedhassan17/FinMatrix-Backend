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

describe('AuthService', () => {
  let service: AuthService;
  let users: { findByEmail: jest.Mock; getByIdOrFail: jest.Mock; save: jest.Mock };
  let verificationRepo: ReturnType<typeof repoMock>;
  let otpRepo: ReturnType<typeof repoMock>;
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
    mail = {
      sendVerificationEmail: jest.fn(),
      sendOtpEmail: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: { signAsync: jest.fn(), decode: jest.fn(), verify: jest.fn() } },
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
        { provide: getRepositoryToken(RefreshToken), useValue: repoMock() },
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
});
