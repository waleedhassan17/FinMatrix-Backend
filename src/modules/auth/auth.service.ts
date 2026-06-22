import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
// bcryptjs (pure JS) instead of native bcrypt: the native .node binary cannot
// be bundled by Vercel's serverless builder. Hashes are byte-compatible.
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt } from 'crypto';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { EmailVerification } from './entities/email-verification.entity';
import { PasswordResetOtp } from './entities/password-reset-otp.entity';
import { SignupDto } from './dto/signup.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  SigninDto,
  VerifyOtpDto,
} from './dto/signin.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { UserRole } from '../../types';
import { MailService } from '../mail/mail.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    phone: string | null;
    companyId: string | null;
    defaultCompanyId: string | null;
    isEmailVerified: boolean;
  };
  tokens: TokenPair;
  companyId: string | null;
  company: { id: string; name: string; status: string | null } | null;
  companyStatus: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    @InjectRepository(RefreshToken)
    private readonly refreshRepo: Repository<RefreshToken>,
    @InjectRepository(EmailVerification)
    private readonly verificationRepo: Repository<EmailVerification>,
    @InjectRepository(PasswordResetOtp)
    private readonly otpRepo: Repository<PasswordResetOtp>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany)
    private readonly userCompanyRepo: Repository<UserCompany>,
  ) {}

  // ------- Public API -------

  async signup(dto: SignupDto): Promise<AuthResult> {
    const email = dto.email.toLowerCase();
    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictException({
        code: 'EMAIL_EXISTS',
        message: 'An account with this email already exists',
      });
    }

    const cost = this.config.get<number>('app.bcryptCost', 12);
    const passwordHash = await bcrypt.hash(dto.password, cost);

    // Company admins must verify their email; delivery users are added against
    // an existing (already-approved) company via invite code, so they are
    // considered verified on creation.
    const isAdmin = dto.role === 'admin';

    const result = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email,
        passwordHash,
        displayName: dto.displayName,
        phone: dto.phone ?? null,
        role: dto.role,
        isActive: true,
        isEmailVerified: !isAdmin,
        emailVerifiedAt: isAdmin ? null : new Date(),
        defaultCompanyId: null,
      });
      await manager.save(user);

      let companyId: string | null = null;
      let company: Company | null = null;

      if (dto.role === 'delivery') {
        if (!dto.companyCode) {
          throw new BadRequestException({
            code: 'MISSING_REQUIRED_FIELD',
            message: 'companyCode is required for delivery users',
          });
        }
        company = await manager.findOne(Company, {
          where: { inviteCode: dto.companyCode.toUpperCase() },
        });
        if (!company) {
          throw new BadRequestException({
            code: 'INVALID_CODE',
            message: 'Invalid company invite code',
          });
        }
        await manager.save(
          manager.create(UserCompany, {
            userId: user.id,
            companyId: company.id,
            role: 'delivery',
          }),
        );
        companyId = company.id;
        user.defaultCompanyId = company.id;
        await manager.save(user);
      }

      return { user, companyId, company };
    });

    // Fire the verification email for company admins (best-effort; never blocks).
    if (isAdmin) {
      const token = await this.issueEmailVerification(result.user.id);
      await this.mail.sendVerificationEmail(email, dto.displayName, token);
    }

    const tokens = await this.issueTokens(result.user, result.companyId, dto.role);
    return {
      user: this.toPublicUser(result.user, result.companyId),
      tokens,
      companyId: result.companyId,
      company: result.company
        ? { id: result.company.id, name: result.company.name, status: result.company.status }
        : null,
      companyStatus: result.company?.status ?? null,
    };
  }

  async signin(dto: SigninDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.isActive) {
      this.logger.warn(`Failed login (no user/inactive): ${dto.email}`);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      this.logger.warn(`Failed login (bad password): ${dto.email}`);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    // Hard gate: company admins cannot sign in until their email is verified.
    if (user.role === 'admin' && !user.isEmailVerified) {
      this.logger.warn(`Login blocked (email not verified): ${dto.email}`);
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before signing in.',
        email: user.email,
      });
    }

    const membership = user.defaultCompanyId
      ? await this.userCompanyRepo.findOne({
          where: { userId: user.id, companyId: user.defaultCompanyId },
          relations: { company: true },
        })
      : await this.userCompanyRepo.findOne({
          where: { userId: user.id },
          relations: { company: true },
        });

    // super_admin is a platform-level role — never let a company membership override it
    const isSuperAdmin = user.role === 'super_admin';
    const companyId = isSuperAdmin ? null : membership?.companyId ?? null;
    const role: UserRole = isSuperAdmin
      ? 'super_admin'
      : ((membership?.role ?? user.role) as UserRole);

    const tokens = await this.issueTokens(user, companyId, role);
    const company = membership?.company ?? null;
    return {
      user: this.toPublicUser(user, companyId),
      tokens,
      companyId,
      company: company ? { id: company.id, name: company.name, status: company.status } : null,
      companyStatus: company?.status ?? null,
    };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('jwt.secret'),
      });
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired refresh token',
      });
    }

    const hash = this.hashToken(refreshToken);
    const stored = await this.refreshRepo.findOne({ where: { tokenHash: hash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Refresh token has been revoked or expired',
      });
    }

    const user = await this.users.getByIdOrFail(payload.sub);
    stored.revokedAt = new Date();
    await this.refreshRepo.save(stored);
    return this.issueTokens(user, payload.companyId, payload.role);
  }

  async signout(userId: string): Promise<{ revoked: number }> {
    const res = await this.refreshRepo.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return { revoked: res.affected ?? 0 };
  }

  // ── Email verification ────────────────────────────────────────────────────

  /** Generate, persist (hashed) and return a single-use verification token. */
  private async issueEmailVerification(userId: string): Promise<string> {
    // Invalidate any outstanding tokens for this user first.
    await this.verificationRepo.update(
      { userId, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    const token = randomBytes(32).toString('hex');
    const ttlHours = this.config.get<number>('mail.verificationTtlHours', 24);
    await this.verificationRepo.save(
      this.verificationRepo.create({
        userId,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
        usedAt: null,
      }),
    );
    return token;
  }

  async verifyEmail(token: string): Promise<{ verified: true; email: string }> {
    if (!token) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'Verification token is required',
      });
    }
    const record = await this.verificationRepo.findOne({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'Verification link is invalid, used, or expired',
      });
    }
    const user = await this.users.getByIdOrFail(record.userId);

    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      user.emailVerifiedAt = new Date();
      await this.users.save(user);
    }
    record.usedAt = new Date();
    await this.verificationRepo.save(record);
    this.logger.log(`Email verified: ${user.email}`);
    return { verified: true, email: user.email };
  }

  async resendVerification(email: string): Promise<{ delivered: boolean }> {
    const user = await this.users.findByEmail(email);
    // Don't leak whether the email exists or is already verified.
    if (!user || user.isEmailVerified || user.role !== 'admin') {
      return { delivered: true };
    }
    const token = await this.issueEmailVerification(user.id);
    await this.mail.sendVerificationEmail(user.email, user.displayName, token);
    return { delivered: true };
  }

  // ── Forgot password (OTP flow) ────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ delivered: boolean }> {
    const user = await this.users.findByEmail(dto.email);
    // Always respond positively to avoid user enumeration.
    if (!user) return { delivered: true };

    // Invalidate previous outstanding OTPs.
    await this.otpRepo.update(
      { userId: user.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttlMin = this.config.get<number>('mail.otpTtlMinutes', 10);
    await this.otpRepo.save(
      this.otpRepo.create({
        userId: user.id,
        otpHash: this.hashToken(otp),
        resetTokenHash: null,
        attempts: 0,
        expiresAt: new Date(Date.now() + ttlMin * 60_000),
        verifiedAt: null,
        usedAt: null,
      }),
    );
    await this.mail.sendOtpEmail(user.email, user.displayName, otp);
    this.logger.log(`Password reset OTP issued for ${user.email}`);
    return { delivered: true };
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<{ resetToken: string }> {
    const user = await this.users.findByEmail(dto.email);
    const genericError = new BadRequestException({
      code: 'INVALID_OTP',
      message: 'The code is invalid or has expired',
    });
    if (!user) throw genericError;

    const record = await this.otpRepo.findOne({
      where: { userId: user.id, usedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });
    if (!record) throw genericError;

    const maxAttempts = this.config.get<number>('mail.otpMaxAttempts', 5);
    if (record.attempts >= maxAttempts) {
      record.usedAt = new Date();
      await this.otpRepo.save(record);
      this.logger.warn(`OTP locked (too many attempts): ${user.email}`);
      throw new BadRequestException({
        code: 'OTP_LOCKED',
        message: 'Too many incorrect attempts. Please request a new code.',
      });
    }

    if (record.otpHash !== this.hashToken(dto.otp)) {
      record.attempts += 1;
      await this.otpRepo.save(record);
      this.logger.warn(
        `OTP mismatch (${record.attempts}/${maxAttempts}): ${user.email}`,
      );
      throw genericError;
    }

    // Correct — issue a single-use reset token for the final step.
    const resetToken = randomBytes(32).toString('hex');
    record.verifiedAt = new Date();
    record.resetTokenHash = this.hashToken(resetToken);
    await this.otpRepo.save(record);
    return { resetToken };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ success: boolean }> {
    const user = await this.users.findByEmail(dto.email);
    const invalid = new BadRequestException({
      code: 'INVALID_TOKEN',
      message: 'Reset session is invalid or expired. Please start again.',
    });
    if (!user) throw invalid;

    const record = await this.otpRepo.findOne({
      where: {
        userId: user.id,
        resetTokenHash: this.hashToken(dto.resetToken),
        usedAt: IsNull(),
      },
    });
    if (!record || !record.verifiedAt || record.expiresAt < new Date()) {
      throw invalid;
    }

    const cost = this.config.get<number>('app.bcryptCost', 12);
    user.passwordHash = await bcrypt.hash(dto.password, cost);
    await this.users.save(user);

    record.usedAt = new Date();
    await this.otpRepo.save(record);

    // Revoke all refresh tokens for safety.
    await this.refreshRepo.update(
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    this.logger.log(`Password reset completed: ${user.email}`);
    return { success: true };
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async getMe(userId: string): Promise<{
    user: ReturnType<AuthService['toPublicUser']>;
    companies: {
      id: string;
      name: string;
      role: UserRole;
      inviteCode: string;
      status: string | null;
    }[];
    companyId: string | null;
    company: { id: string; name: string; status: string | null } | null;
    companyStatus: string | null;
  }> {
    const user = await this.users.getByIdOrFail(userId);
    const memberships = await this.userCompanyRepo.find({
      where: { userId: user.id },
      relations: { company: true },
    });
    const primary = memberships[0] ?? null;
    const companyId = primary?.companyId ?? user.defaultCompanyId ?? null;
    return {
      user: this.toPublicUser(user, companyId),
      companies: memberships.map((m) => ({
        id: m.companyId,
        name: m.company.name,
        role: m.role,
        inviteCode: m.company.inviteCode,
        status: m.company.status,
      })),
      companyId,
      company: primary?.company
        ? { id: primary.company.id, name: primary.company.name, status: primary.company.status }
        : null,
      companyStatus: primary?.company?.status ?? null,
    };
  }

  // ------- Helpers -------

  private async issueTokens(
    user: User,
    companyId: string | null,
    role: UserRole,
  ): Promise<TokenPair> {
    const payload: JwtPayload = { sub: user.id, companyId, role };

    const secret = this.config.getOrThrow<string>('jwt.secret');
    const accessExpires = this.config.get<string>('jwt.accessExpiresIn', '15m');
    const refreshExpires = this.config.get<string>('jwt.refreshExpiresIn', '30d');

    const accessToken = await this.jwt.signAsync(payload, {
      secret,
      expiresIn: accessExpires as unknown as number,
    });
    const refreshTokenStr = await this.jwt.signAsync(payload, {
      secret,
      expiresIn: refreshExpires as unknown as number,
    });

    const decoded = this.jwt.decode(refreshTokenStr) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);

    await this.refreshRepo.save(
      this.refreshRepo.create({
        userId: user.id,
        tokenHash: this.hashToken(refreshTokenStr),
        expiresAt,
        revokedAt: null,
      }),
    );

    const decodedAccess = this.jwt.decode(accessToken) as { exp: number; iat: number };
    const expiresIn = decodedAccess.exp - decodedAccess.iat;

    return { accessToken, refreshToken: refreshTokenStr, expiresIn };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPublicUser(user: User, companyId?: string | null) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      phone: user.phone,
      companyId: companyId ?? user.defaultCompanyId ?? null,
      defaultCompanyId: user.defaultCompanyId,
      isEmailVerified: user.isEmailVerified,
    };
  }
}
