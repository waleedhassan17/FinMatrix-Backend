import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordReset } from './entities/password-reset.entity';
import { SignupDto } from './dto/signup.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  SigninDto,
} from './dto/signin.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { UserRole } from '../../types';

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
  };
  tokens: TokenPair;
  companyId: string | null;
  company: { id: string; name: string } | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    @InjectRepository(RefreshToken)
    private readonly refreshRepo: Repository<RefreshToken>,
    @InjectRepository(PasswordReset)
    private readonly resetRepo: Repository<PasswordReset>,
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

    const result = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email,
        passwordHash,
        displayName: dto.displayName,
        phone: dto.phone ?? null,
        role: dto.role,
        isActive: true,
        defaultCompanyId: null,
      });
      await manager.save(user);

      let companyId: string | null = null;

      if (dto.role === 'delivery') {
        if (!dto.companyCode) {
          throw new BadRequestException({
            code: 'MISSING_REQUIRED_FIELD',
            message: 'companyCode is required for delivery users',
          });
        }
        const company = await manager.findOne(Company, {
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

      return { user, companyId };
    });

    const tokens = await this.issueTokens(result.user, result.companyId, dto.role);
    return {
      user: this.toPublicUser(result.user, result.companyId),
      tokens,
      companyId: result.companyId,
      company: result.companyId ? { id: result.companyId, name: dto.companyCode ?? '' } : null,
    };
  }

  async signin(dto: SigninDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const membership = user.defaultCompanyId
      ? await this.userCompanyRepo.findOne({
          where: { userId: user.id, companyId: user.defaultCompanyId },
          relations: { company: true },
        })
      : await this.userCompanyRepo.findOne({ where: { userId: user.id }, relations: { company: true } });

    const companyId = membership?.companyId ?? null;
    const role: UserRole = (membership?.role ?? user.role) as UserRole;

    const tokens = await this.issueTokens(user, companyId, role);
    return {
      user: this.toPublicUser(user, companyId),
      tokens,
      companyId,
      company: membership?.company ? { id: membership.company.id, name: membership.company.name } : null,
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

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ delivered: boolean }> {
    const user = await this.users.findByEmail(dto.email);
    // Always respond positively to avoid user enumeration.
    if (!user) return { delivered: true };

    const token = randomBytes(32).toString('hex');
    const reset = this.resetRepo.create({
      userId: user.id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      usedAt: null,
    });
    await this.resetRepo.save(reset);
    this.logger.log(
      `[DEV] Password reset for ${user.email}: token=${token} (expires in 1h)`,
    );
    return { delivered: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ success: boolean }> {
    const reset = await this.resetRepo.findOne({
      where: { tokenHash: this.hashToken(dto.token) },
    });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'Reset token is invalid, used, or expired',
      });
    }
    const user = await this.users.getByIdOrFail(reset.userId);

    const cost = this.config.get<number>('app.bcryptCost', 12);
    user.passwordHash = await bcrypt.hash(dto.password, cost);
    await this.users.save(user);

    reset.usedAt = new Date();
    await this.resetRepo.save(reset);
    // Revoke all refresh tokens for safety.
    await this.refreshRepo.update(
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return { success: true };
  }

  async getMe(userId: string): Promise<{
    user: ReturnType<AuthService['toPublicUser']>;
    companies: { id: string; name: string; role: UserRole; inviteCode: string }[];
    companyId: string | null;
    company: { id: string; name: string } | null;
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
      })),
      companyId,
      company: primary?.company ? { id: primary.company.id, name: primary.company.name } : null,
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
    };
  }

  async verifyEmail(token: string) {
    // In a real implementation, we would decode the token, find the user, and set isEmailVerified = true.
    // For this demo, we mock the success response.
    this.logger.log(`Email verification successful for token: ${token}`);
    return { success: true, message: 'Email verified successfully.' };
  }

  async resendVerification(email: string) {
    const user = await this.users.findByEmail(email);
    if (!user) {
      // Don't leak user existence
      return { success: true, message: 'If the email exists, a verification link has been sent.' };
    }
    const token = randomBytes(32).toString('hex'); // Mock token
    this.logger.log(`[DEMO] Verification token generated for ${email}: ${token}`);
    return { success: true, message: 'If the email exists, a verification link has been sent.' };
  }

  async checkVerification(userId: string) {
    // Mocking that the user is verified for the demo.
    // In reality, this would check `user.isEmailVerified`.
    return { verified: true };
  }
}
