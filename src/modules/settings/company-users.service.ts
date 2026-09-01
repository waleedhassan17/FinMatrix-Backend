import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Not } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/entities/user.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { ManagedCredential } from '../users/entities/managed-credential.entity';
import { CredentialVaultService } from '../users/credential-vault.service';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import {
  CompanyRole,
  CreateCompanyUserDto,
  ResetCompanyUserPasswordDto,
} from './dto/company-user.dto';

export interface CompanyUserView {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  role: CompanyRole;
  status: 'active' | 'inactive';
  /** Whether a shareable password is on file for this account. */
  hasStoredCredential: boolean;
}

/**
 * Company member management — the real implementation behind /settings/users,
 * which shipped as stubs returning empty arrays.
 *
 * The account-creation mechanics deliberately mirror
 * DeliveryPersonnelService.create(): one transaction, a bcrypt hash, a row in
 * `users` and a row in `user_companies`. The role that matters is the one on
 * `user_companies` — AuthService resolves the JWT role from the membership,
 * falling back to users.role — so promoting or demoting somebody is a change
 * to the MEMBERSHIP, never to the global user row. Editing users.role instead
 * would silently change the person's role in every other company they belong
 * to, which is the bug the old stub had.
 */
@Injectable()
export class CompanyUsersService {
  private readonly logger = new Logger(CompanyUsersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly vault: CredentialVaultService,
    private readonly audit: OperationalAuditService,
    private readonly config: ConfigService,
  ) {}

  /** Exposed so the deprecated invite alias can mint a password. */
  generatePassword(): string {
    return this.vault.generatePassword();
  }

  async list(companyId: string): Promise<CompanyUserView[]> {
    const rows = await this.dataSource
      .getRepository(UserCompany)
      .find({ where: { companyId }, relations: { user: true } });

    const credentialed = new Set(
      (
        await this.dataSource
          .getRepository(ManagedCredential)
          .find({ where: { companyId }, select: { userId: true } })
      ).map((c) => c.userId),
    );

    return rows
      // Riders live on their own screen, with their own profile fields.
      .filter((m) => m.role === 'admin' || m.role === 'staff')
      .map((m) => this.toView(m, credentialed.has(m.userId)));
  }

  async create(
    companyId: string,
    dto: CreateCompanyUserDto,
    actorUserId: string,
  ): Promise<CompanyUserView & { credentials: { username: string; password: string } }> {
    const username = dto.username.trim().toLowerCase();
    const email = dto.email?.trim().toLowerCase() ?? null;

    const created = await this.dataSource.transaction(async (em) => {
      // No seat limit. Team size is deliberately NOT priced: an owner needs a
      // second pair of hands regardless of their plan, and the approval flow
      // that makes a staff account safe is core accounting behaviour rather
      // than an upsell. Riders are still capped (deliveryPersonnelLimit) —
      // that one IS priced, and is a different question from who may sign in.
      //
      // Usernames are global: two companies cannot both hold 'manager',
      // because sign-in resolves an account from the username alone with no
      // company context to disambiguate.
      if (await em.getRepository(User).findOne({ where: { username } })) {
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          message: `The username "${username}" is already in use. Choose another.`,
        });
      }
      if (email && (await em.getRepository(User).findOne({ where: { email } }))) {
        throw new ConflictException({
          code: 'EMAIL_EXISTS',
          message: 'An account with this email already exists',
        });
      }

      const cost = this.config.get<number>('app.bcryptCost', 12);
      const user = await em.getRepository(User).save(
        em.getRepository(User).create({
          email,
          username,
          passwordHash: await bcrypt.hash(dto.password, cost),
          displayName: dto.name.trim(),
          phone: dto.phone?.trim() ?? null,
          role: dto.role,
          isActive: true,
          // Nothing to verify: the owner vouched for this account by creating
          // it. Leaving it false would trip the admin sign-in gate the moment
          // somebody promoted this user to admin.
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
          defaultCompanyId: companyId,
        }),
      );

      await em.getRepository(UserCompany).save(
        em.getRepository(UserCompany).create({
          userId: user.id,
          companyId,
          role: dto.role,
        }),
      );

      await this.storeCredential(em, companyId, user.id, dto.password, actorUserId);
      return user;
    });

    await this.audit.record({
      companyId,
      actorUserId,
      action: 'company_user_created',
      targetType: 'user',
      targetId: created.id,
      // Never the password.
      details: { username, role: dto.role },
    });

    return {
      id: created.id,
      name: created.displayName,
      username: created.username,
      email: created.email,
      role: dto.role,
      status: 'active',
      hasStoredCredential: this.vault.isConfigured,
      credentials: { username, password: dto.password },
    };
  }

  async changeRole(
    companyId: string,
    userId: string,
    role: CompanyRole,
    actorUserId: string,
  ): Promise<CompanyUserView> {
    return this.dataSource.transaction(async (em) => {
      const membership = await this.getMembershipOrFail(em, companyId, userId);

      // Demoting the last admin would leave the company with nobody who can
      // approve requests, manage users, or close the books — an unrecoverable
      // state from inside the app.
      if (membership.role === 'admin' && role !== 'admin') {
        await this.assertNotLastAdmin(em, companyId, userId);
      }

      membership.role = role;
      await em.getRepository(UserCompany).save(membership);

      await this.audit.record({
        companyId,
        actorUserId,
        action: 'company_user_role_changed',
        targetType: 'user',
        targetId: userId,
        details: { role },
      });

      return this.toView(membership, false);
    });
  }

  async setActive(
    companyId: string,
    userId: string,
    isActive: boolean,
    actorUserId: string,
  ): Promise<CompanyUserView> {
    return this.dataSource.transaction(async (em) => {
      const membership = await this.getMembershipOrFail(em, companyId, userId);
      if (!isActive && membership.role === 'admin') {
        await this.assertNotLastAdmin(em, companyId, userId);
      }
      if (!isActive && userId === actorUserId) {
        throw new BadRequestException({
          code: 'CANNOT_DEACTIVATE_SELF',
          message: 'You cannot deactivate your own account.',
        });
      }

      // Soft-disable only. JwtStrategy rejects an inactive user on the next
      // request, so the session ends immediately without destroying the
      // history the account is referenced by.
      await em.getRepository(User).update(userId, { isActive });
      membership.user.isActive = isActive;

      await this.audit.record({
        companyId,
        actorUserId,
        action: isActive ? 'company_user_activated' : 'company_user_deactivated',
        targetType: 'user',
        targetId: userId,
      });

      return this.toView(membership, false);
    });
  }

  /**
   * Re-issue the password and hand it back once, for the owner to pass on.
   *
   * This is the ONLY recovery path for an owner-created account: there is no
   * self-service reset (see AuthService.forgotPassword), because the account
   * has no inbox and the owner is its custodian.
   */
  async resetPassword(
    companyId: string,
    userId: string,
    dto: ResetCompanyUserPasswordDto,
    actorUserId: string,
  ): Promise<{ userId: string; username: string | null; password: string }> {
    const password = dto.password ?? this.vault.generatePassword();

    const user = await this.dataSource.transaction(async (em) => {
      const membership = await this.getMembershipOrFail(em, companyId, userId);
      const cost = this.config.get<number>('app.bcryptCost', 12);
      await em
        .getRepository(User)
        .update(userId, { passwordHash: await bcrypt.hash(password, cost) });
      await this.storeCredential(em, companyId, userId, password, actorUserId);
      return membership.user;
    });

    await this.audit.record({
      companyId,
      actorUserId,
      action: 'company_user_password_reset',
      targetType: 'user',
      targetId: userId,
      details: { username: user.username },
    });

    return { userId, username: user.username, password };
  }

  /**
   * Reveal the stored password to a custodian who is entitled to it.
   *
   * Every read is audited: the point of the vault is that the owner can help
   * somebody who is locked out, and the point of the audit row is that doing
   * so leaves a trace.
   */
  async revealCredential(
    companyId: string,
    userId: string,
    actorUserId: string,
  ): Promise<{ userId: string; username: string | null; password: string | null }> {
    const membership = await this.getMembershipOrFail(
      this.dataSource.manager,
      companyId,
      userId,
    );
    const record = await this.dataSource
      .getRepository(ManagedCredential)
      .findOne({ where: { companyId, userId } });

    await this.audit.record({
      companyId,
      actorUserId,
      action: 'company_user_credential_viewed',
      targetType: 'user',
      targetId: userId,
      details: { username: membership.user.username },
    });

    return {
      userId,
      username: membership.user.username,
      // Null when no credential was ever stored, or the key has rotated since.
      // The screen offers "reset password" in that case rather than pretending.
      password: record ? this.vault.decrypt(record.secret) : null,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Upsert rather than insert: re-issuing a password replaces the custodian's
   * copy. Keeping a history here would mean keeping passwords nobody should
   * still be able to use.
   */
  private async storeCredential(
    em: EntityManager,
    companyId: string,
    userId: string,
    password: string,
    issuedBy: string,
  ): Promise<void> {
    if (!this.vault.isConfigured) {
      // Encryption unavailable — do NOT fall back to storing it in clear. The
      // account still works; only the convenience copy is skipped.
      this.logger.warn(
        'CREDENTIAL_ENCRYPTION_KEY is not set — the shareable password was not stored.',
      );
      return;
    }
    const repo = em.getRepository(ManagedCredential);
    const existing = await repo.findOne({ where: { userId } });
    const secret = this.vault.encrypt(password);
    if (existing) {
      existing.secret = secret;
      existing.issuedBy = issuedBy;
      existing.issuedAt = new Date();
      existing.companyId = companyId;
      await repo.save(existing);
      return;
    }
    await repo.save(repo.create({ companyId, userId, secret, issuedBy, issuedAt: new Date() }));
  }

  private async assertNotLastAdmin(
    em: EntityManager,
    companyId: string,
    excludingUserId: string,
  ): Promise<void> {
    const others = await em
      .getRepository(UserCompany)
      .createQueryBuilder('uc')
      .innerJoin('uc.user', 'u')
      .where('uc.companyId = :companyId', { companyId })
      .andWhere('uc.role = :role', { role: 'admin' })
      .andWhere('uc.userId != :excludingUserId', { excludingUserId })
      .andWhere('u.isActive = true')
      .getCount();

    if (others === 0) {
      throw new BadRequestException({
        code: 'LAST_ADMIN',
        message:
          'This is the only active owner. Promote someone else to owner first — a company without one cannot approve requests or manage users.',
      });
    }
  }

  private async getMembershipOrFail(
    em: EntityManager,
    companyId: string,
    userId: string,
  ): Promise<UserCompany> {
    const membership = await em.getRepository(UserCompany).findOne({
      where: { companyId, userId },
      relations: { user: true },
    });
    if (!membership || (membership.role !== 'admin' && membership.role !== 'staff')) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'No such team member in this company.',
      });
    }
    return membership;
  }

  private toView(m: UserCompany, hasStoredCredential: boolean): CompanyUserView {
    return {
      id: m.userId,
      name: m.user?.displayName ?? '',
      username: m.user?.username ?? null,
      email: m.user?.email ?? null,
      role: m.role as CompanyRole,
      status: m.user?.isActive === false ? 'inactive' : 'active',
      hasStoredCredential,
    };
  }
}
