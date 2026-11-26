import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { PlatformAuditService } from '../../common/audit/platform-audit.service';
import {
  childTables,
  COMPANY_FILE_COLUMNS,
  companyTables,
  platformTables,
} from '../../common/company-data/company-data.registry';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { StorageService } from '../../common/storage/storage.service';
import { likeContains } from '../../common/utils/like.util';
import { revokeRefreshTokens } from '../../common/utils/session-revocation.util';
import { businessToday } from '../../common/utils/business-date.util';
import { deletionBackupRetentionDays } from '../../config/launch.settings';
import { CompanyExportBuilder } from '../data-portability/exporter/company-export.builder';
import { MailService } from '../mail/mail.service';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { User } from '../users/entities/user.entity';
import { Company } from '../companies/entities/company.entity';
import { CompanyDeletion } from './entities/company-deletion.entity';
import { PlatformFinalBackup } from './entities/platform-final-backup.entity';

type Q = Pick<EntityManager, 'query'>;

export interface DeleteCompanyInput {
  confirmName: string;
  reason: string;
  allowNewTrial?: boolean;
}

export interface DeleteUserInput {
  confirmEmail: string;
  reason: string;
  allowNewTrial?: boolean;
}

const FINAL_BACKUP_BUCKET = 'deletion-backups';

/** sha256 of the normalised address: proves "who" later without keeping it. */
export function emailHash(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e ? createHash('sha256').update(e).digest('hex') : null;
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Super-admin account control: suspend / reinstate / delete users and
 * companies, and the demo flag.
 *
 * Deletion is permanent and driven by the company-data registry. It runs as a
 * job (company_deletions): suspend at once → final backup when the company has
 * posted entries (demo accounts may skip it) → purge every registered table in
 * ONE transaction → platform audit record. The job row and the audit record
 * survive the company.
 */
@Injectable()
export class AccountAdminService {
  private readonly logger = new Logger(AccountAdminService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly mail: MailService,
    private readonly audit: PlatformAuditService,
    private readonly builder: CompanyExportBuilder,
    private readonly superAdmin: SuperAdminService,
  ) {}

  // ── Users ───────────────────────────────────────────────────────────────

  /** Search users across every company, with their memberships. */
  async searchUsers(q: string | undefined, page = 1, limit = 20) {
    page = Math.max(1, page);
    limit = Math.min(Math.max(limit, 1), 100);
    const term = q?.trim();
    const params: unknown[] = [];
    let where = 'true';
    if (term) {
      params.push(likeContains(term));
      where = `(u.email ILIKE $1 OR u.username ILIKE $1 OR u.display_name ILIKE $1
                OR u.phone ILIKE $1 OR EXISTS (
                  SELECT 1 FROM user_companies m JOIN companies c ON c.id = m.company_id
                   WHERE m.user_id = u.id AND c.name ILIKE $1))`;
    }
    const [{ total }] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM users u WHERE ${where}`,
      params,
    );
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT u.id, u.email, u.username, u.display_name, u.phone, u.role,
              u.is_active, u.is_email_verified, u.suspended_at, u.suspension_reason,
              u.created_at,
              coalesce(json_agg(json_build_object(
                'companyId', c.id, 'companyName', c.name, 'role', m.role,
                'isOwner', c.created_by = u.id, 'isDemo', c.is_demo,
                'suspended', c.suspended_at IS NOT NULL))
                FILTER (WHERE c.id IS NOT NULL), '[]') AS memberships
         FROM users u
         LEFT JOIN user_companies m ON m.user_id = u.id
         LEFT JOIN companies c ON c.id = m.company_id
        WHERE ${where}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    // `items`, not `data` (the response envelope unwraps `data`).
    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        username: r.username,
        displayName: r.display_name,
        phone: r.phone,
        role: r.role,
        isActive: r.is_active,
        isEmailVerified: r.is_email_verified,
        suspendedAt: r.suspended_at,
        suspensionReason: r.suspension_reason,
        createdAt: r.created_at,
        memberships: r.memberships,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** Never a super-admin, never yourself. */
  private assertTargetable(target: User | null, admin: AuthenticatedUser) {
    if (!target) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    if (target.role === 'super_admin') {
      throw new ForbiddenException({
        code: 'CANNOT_TARGET_SUPER_ADMIN',
        message: 'A super-admin account cannot be suspended or deleted here.',
      });
    }
    if (target.id === admin.id) {
      throw new ForbiddenException({
        code: 'CANNOT_TARGET_SELF',
        message: 'You cannot suspend or delete your own account.',
      });
    }
  }

  /**
   * Suspend a person everywhere, effective on their NEXT request: isActive
   * false, every refresh session revoked, and the token version bumped so
   * every access token in flight is refused by JwtStrategy.
   */
  async suspendUser(userId: string, admin: AuthenticatedUser, reason: string) {
    const why = (reason ?? '').trim();
    if (why.length < 3) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Give a reason for suspending this account.',
      });
    }
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
    });
    this.assertTargetable(user, admin);
    const target = user as User;
    if (!target.suspendedAt) {
      await this.dataSource.transaction(async (em) => {
        await em.query(
          `UPDATE users SET suspended_at = now(), suspended_by = $2,
                  suspension_reason = $3, is_active = false,
                  token_version = token_version + 1, updated_at = now()
            WHERE id = $1`,
          [userId, admin.id, why.slice(0, 500)],
        );
        await revokeRefreshTokens(em, userId);
      });
      if (target.email) {
        await this.mail.sendAccountSuspendedEmail(
          target.email,
          target.displayName,
          why,
        );
      }
      await this.audit.record({
        actorUserId: admin.id,
        actorLabel: admin.email,
        action: 'user_suspended',
        targetType: 'user',
        targetId: userId,
        reason: why,
        details: { emailHash: emailHash(target.email) },
      });
    }
    return this.userStatus(userId);
  }

  async reinstateUser(userId: string, admin: AuthenticatedUser) {
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
    });
    this.assertTargetable(user, admin);
    const target = user as User;
    if (target.suspendedAt) {
      await this.dataSource.query(
        `UPDATE users SET suspended_at = NULL, suspended_by = NULL,
                suspension_reason = NULL, is_active = true, updated_at = now()
          WHERE id = $1`,
        [userId],
      );
      if (target.email) {
        await this.mail.sendAccountReinstatedEmail(
          target.email,
          target.displayName,
        );
      }
      await this.audit.record({
        actorUserId: admin.id,
        actorLabel: admin.email,
        action: 'user_reinstated',
        targetType: 'user',
        targetId: userId,
      });
    }
    return this.userStatus(userId);
  }

  private async userStatus(userId: string) {
    const [row] = await this.dataSource.query(
      `SELECT id, email, username, is_active, suspended_at, suspension_reason
         FROM users WHERE id = $1`,
      [userId],
    );
    return row
      ? {
          id: row.id,
          email: row.email,
          username: row.username,
          isActive: row.is_active,
          suspendedAt: row.suspended_at,
          suspensionReason: row.suspension_reason,
        }
      : null;
  }

  /**
   * Delete one person. Refused while they own a company — delete the company
   * or transfer ownership first. Their memberships go with them; the email,
   * username and phone are free to register again afterwards.
   */
  async deleteUser(
    userId: string,
    admin: AuthenticatedUser,
    input: DeleteUserInput,
  ) {
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
    });
    this.assertTargetable(user, admin);
    const target = user as User;
    const expected = target.email ?? target.username ?? '';
    if (
      (input.confirmEmail ?? '').trim().toLowerCase() !== expected.toLowerCase()
    ) {
      throw new BadRequestException({
        code: 'CONFIRMATION_MISMATCH',
        message: `Type ${target.email ? 'the email address' : 'the username'} exactly to confirm.`,
      });
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Give a reason for deleting this account.',
      });
    }
    const owned: Array<{ id: string; name: string }> =
      await this.dataSource.query(
        `SELECT c.id, c.name FROM companies c
        WHERE c.created_by = $1
           OR (EXISTS (SELECT 1 FROM user_companies m
                        WHERE m.company_id = c.id AND m.user_id = $1 AND m.role = 'admin')
               AND NOT EXISTS (SELECT 1 FROM user_companies o
                        WHERE o.company_id = c.id AND o.user_id <> $1 AND o.role = 'admin'))`,
        [userId],
      );
    if (owned.length) {
      throw new ConflictException({
        code: 'SOLE_OWNER',
        message: `This person owns ${owned.map((c) => c.name).join(', ')}. Delete the company or transfer ownership first.`,
        details: { companies: owned },
      });
    }

    const counts = await this.dataSource.transaction(async (em) => {
      if (input.allowNewTrial) {
        await this.releaseTrialClaims(em, { userIds: [userId] });
      }
      const memberships = await em.query(
        `SELECT count(*)::int AS n FROM user_companies WHERE user_id = $1`,
        [userId],
      );
      await this.deleteUsers(em, [userId]);
      return { membershipsRemoved: memberships[0].n as number };
    });
    await this.audit.record({
      actorUserId: admin.id,
      actorLabel: admin.email,
      action: 'user_deleted',
      targetType: 'user',
      targetId: userId,
      reason,
      details: {
        emailHash: emailHash(target.email),
        username: target.username ? '(set)' : null,
        allowNewTrial: !!input.allowNewTrial,
        ...counts,
      },
    });
    return { deleted: true, userId, ...counts };
  }

  // ── Companies: demo flag, preview, deletion ─────────────────────────────

  async setDemo(companyId: string, admin: AuthenticatedUser, isDemo: boolean) {
    const res = await this.dataSource.query(
      `UPDATE companies SET is_demo = $2, updated_at = now() WHERE id = $1
       RETURNING id, name, is_demo`,
      [companyId, isDemo],
    );
    const row = res[0]?.[0] ?? res[0];
    if (!row) throw new NotFoundException('Company not found');
    await this.audit.record({
      actorUserId: admin.id,
      actorLabel: admin.email,
      action: isDemo ? 'company_flagged_demo' : 'company_unflagged_demo',
      targetType: 'company',
      targetId: companyId,
      companyId,
      companyName: row.name,
    });
    return { id: row.id, name: row.name, isDemo: row.is_demo };
  }

  /** What deleting this company would remove — shown before the admin confirms. */
  async deletionPreview(companyId: string) {
    const company = await this.companyOrFail(companyId);
    const tables = await this.existingTables(this.dataSource.manager);
    const rowCounts = await this.countRows(
      this.dataSource.manager,
      companyId,
      tables,
    );
    const files = await this.collectFileKeys(
      this.dataSource.manager,
      companyId,
      tables,
    );
    const members = await this.memberPlan(this.dataSource.manager, companyId);
    const postedEntries = await this.postedEntryCount(
      this.dataSource.manager,
      companyId,
    );
    return {
      companyId,
      companyName: company.name,
      isDemo: company.isDemo,
      rowCounts,
      totalRows: Object.values(rowCounts).reduce((a, b) => a + b, 0),
      files: files.length,
      postedEntries,
      finalBackup: postedEntries > 0 && !company.isDemo,
      usersDeleted: members.deleteUsers.length,
      membershipsRemoved: members.keepUsers.length,
      allowNewTrialDefault: company.isDemo,
    };
  }

  /**
   * Ask for a company to be deleted. Suspends it at once (nobody can use it
   * while the backup and purge run), records the job and starts it.
   */
  async requestCompanyDeletion(
    companyId: string,
    admin: AuthenticatedUser,
    input: DeleteCompanyInput,
  ) {
    const company = await this.companyOrFail(companyId);
    if ((input.confirmName ?? '').trim() !== company.name.trim()) {
      throw new BadRequestException({
        code: 'CONFIRMATION_MISMATCH',
        message: 'Type the company name exactly to confirm.',
      });
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Give a reason for deleting this company.',
      });
    }
    await this.assertNoProtectedMembers(companyId, admin);
    const job = await this.createDeletionJob(company, admin, {
      reason,
      allowNewTrial: input.allowNewTrial ?? company.isDemo,
    });
    this.kick(job.id);
    return this.deletionView(job);
  }

  private async assertNoProtectedMembers(
    companyId: string,
    admin: AuthenticatedUser,
  ) {
    const protectedMembers: Array<{ id: string; role: string }> =
      await this.dataSource.query(
        `SELECT u.id, u.role FROM user_companies m JOIN users u ON u.id = m.user_id
          WHERE m.company_id = $1 AND (u.role = 'super_admin' OR u.id = $2)`,
        [companyId, admin.id],
      );
    if (protectedMembers.some((m) => m.role === 'super_admin')) {
      throw new ForbiddenException({
        code: 'CANNOT_TARGET_SUPER_ADMIN',
        message:
          'This company has a super-admin member and cannot be deleted here.',
      });
    }
    if (protectedMembers.some((m) => m.id === admin.id)) {
      throw new ForbiddenException({
        code: 'CANNOT_TARGET_SELF',
        message: 'You are a member of this company and cannot delete it.',
      });
    }
  }

  private async createDeletionJob(
    company: Company,
    admin: AuthenticatedUser,
    opts: { reason: string; allowNewTrial: boolean },
  ): Promise<CompanyDeletion> {
    const posted = await this.postedEntryCount(
      this.dataSource.manager,
      company.id,
    );
    const repo = this.dataSource.getRepository(CompanyDeletion);
    let job: CompanyDeletion;
    try {
      job = await repo.save(
        repo.create({
          companyId: company.id,
          companyName: company.name,
          requestedBy: admin.id,
          reason: opts.reason,
          allowNewTrial: opts.allowNewTrial,
          isDemo: company.isDemo,
          status: 'pending',
          backupRequired: posted > 0 && !company.isDemo,
        }),
      );
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } }).driverError?.code ===
        '23505'
      ) {
        throw new ConflictException({
          code: 'DELETION_IN_PROGRESS',
          message: 'This company is already being deleted.',
        });
      }
      throw err;
    }
    // Lock everyone out straight away.
    if (!company.suspendedAt) {
      await this.superAdmin.suspendCompany(
        company.id,
        admin.id,
        `Being deleted: ${opts.reason}`,
      );
    }
    await this.audit.record({
      actorUserId: admin.id,
      actorLabel: admin.email,
      action: 'company_deletion_requested',
      targetType: 'company',
      targetId: company.id,
      companyId: company.id,
      companyName: company.name,
      reason: opts.reason,
      details: {
        deletionId: job.id,
        allowNewTrial: opts.allowNewTrial,
        backupRequired: job.backupRequired,
      },
    });
    return job;
  }

  async getDeletion(id: string) {
    const job = await this.dataSource
      .getRepository(CompanyDeletion)
      .findOne({ where: { id } });
    if (!job) throw new NotFoundException('Deletion not found');
    return this.deletionView(job);
  }

  private deletionView(job: CompanyDeletion) {
    return {
      id: job.id,
      companyId: job.companyId,
      companyName: job.companyName,
      status: job.status,
      backupRequired: job.backupRequired,
      finalBackupId: job.finalBackupId,
      rowCounts: job.rowCounts,
      filesDeleted: job.filesDeleted,
      filesFailed: job.filesFailed,
      usersDeleted: job.usersDeleted,
      membershipsRemoved: job.membershipsRemoved,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    };
  }

  /**
   * Bulk actions on the company list. Suspension works on any company;
   * deletion ONLY when every selected company is flagged demo/test.
   */
  async bulk(
    admin: AuthenticatedUser,
    input: { action: 'suspend' | 'delete'; ids: string[]; reason: string },
  ) {
    const ids = [...new Set(input.ids ?? [])];
    if (!ids.length || ids.length > 200) {
      throw new BadRequestException({
        code: 'INVALID_SELECTION',
        message: 'Select between 1 and 200 companies.',
      });
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Give a reason.',
      });
    }
    const companies = await this.dataSource
      .getRepository(Company)
      .createQueryBuilder('c')
      .where('c.id IN (:...ids)', { ids })
      .getMany();
    if (companies.length !== ids.length) {
      throw new NotFoundException('One or more companies were not found');
    }
    if (input.action === 'delete') {
      const notDemo = companies.filter((c) => !c.isDemo);
      if (notDemo.length) {
        throw new BadRequestException({
          code: 'BULK_DELETE_DEMO_ONLY',
          message:
            'Bulk delete is only allowed for demo/test accounts. Remove the others from the selection.',
          details: {
            companies: notDemo.map((c) => ({ id: c.id, name: c.name })),
          },
        });
      }
      const jobs = [];
      for (const c of companies) {
        await this.assertNoProtectedMembers(c.id, admin);
        const job = await this.createDeletionJob(c, admin, {
          reason,
          allowNewTrial: true,
        });
        jobs.push(this.deletionView(job));
      }
      for (const j of jobs) this.kick(j.id);
      return { action: 'delete', jobs };
    }
    const results = [];
    for (const c of companies) {
      results.push(
        await this.superAdmin.suspendCompany(c.id, admin.id, reason),
      );
    }
    return { action: 'suspend', results };
  }

  /** Deleted companies and users (from the platform audit) + live backups. */
  async deletedAccounts(limit = 100) {
    const events = await this.audit.list({
      actions: ['company_deleted', 'user_deleted'],
      limit,
    });
    const backups = await this.dataSource
      .getRepository(PlatformFinalBackup)
      .createQueryBuilder('b')
      .where('b.deletedAt IS NULL')
      .andWhere('b.expiresAt > now()')
      .getMany();
    const byCompany = new Map(backups.map((b) => [b.companyId, b]));
    return events.map((e) => {
      const b = e.companyId ? byCompany.get(e.companyId) : undefined;
      return {
        id: e.id,
        action: e.action,
        at: e.createdAt,
        actorUserId: e.actorUserId,
        actorLabel: e.actorLabel,
        companyId: e.companyId,
        companyName: e.companyName,
        reason: e.reason,
        details: e.details,
        finalBackup: b
          ? {
              id: b.id,
              sizeBytes: Number(b.sizeBytes),
              expiresAt: b.expiresAt,
            }
          : null,
      };
    });
  }

  async openFinalBackup(backupId: string) {
    const b = await this.dataSource
      .getRepository(PlatformFinalBackup)
      .findOne({ where: { id: backupId } });
    if (!b || b.deletedAt || !b.storageKey || b.expiresAt < new Date()) {
      throw new NotFoundException({
        code: 'BACKUP_EXPIRED',
        message: 'This final backup is no longer available.',
      });
    }
    const file = await this.storage.read(b.storageKey);
    if (!file) throw new NotFoundException('Backup file not found');
    return { file, backup: b };
  }

  /** Delete final backups past their retention (hourly). */
  async sweepExpiredFinalBackups(): Promise<number> {
    const due = await this.dataSource
      .getRepository(PlatformFinalBackup)
      .createQueryBuilder('b')
      .where('b.deletedAt IS NULL')
      .andWhere('b.expiresAt <= now()')
      .getMany();
    for (const b of due) {
      if (b.storageKey) await this.storage.remove(b.storageKey);
      await this.dataSource
        .getRepository(PlatformFinalBackup)
        .update({ id: b.id }, { deletedAt: new Date(), storageKey: null });
    }
    return due.length;
  }

  // ── The deletion job ────────────────────────────────────────────────────

  /** Start a job in the background (the worker also picks up stragglers). */
  kick(jobId: string) {
    if (process.env.ACCOUNT_DELETION_WORKER_ENABLED === 'false') return;
    void this.process(jobId).catch((err: Error) =>
      this.logger.error(`deletion ${jobId} failed: ${err.message}`),
    );
  }

  /** Claim the oldest pending job (FOR UPDATE SKIP LOCKED) and run it. */
  async runNext(): Promise<boolean> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM company_deletions
        WHERE status = 'pending'
           OR (status IN ('backing_up', 'deleting') AND updated_at < now() - interval '45 minutes'
               AND attempts < 3)
        ORDER BY created_at LIMIT 1`,
    );
    if (!rows.length) return false;
    await this.process(rows[0].id);
    return true;
  }

  async process(jobId: string): Promise<void> {
    if (this.inFlight.has(jobId)) return;
    this.inFlight.add(jobId);
    const repo = this.dataSource.getRepository(CompanyDeletion);
    try {
      // Claim: only one process runs a job.
      const claimed = await this.dataSource.query(
        `UPDATE company_deletions
            SET status = CASE WHEN backup_required THEN 'backing_up' ELSE 'deleting' END,
                attempts = attempts + 1, started_at = coalesce(started_at, now()),
                updated_at = now(), error = NULL
          WHERE id = $1 AND (status = 'pending'
                OR (status IN ('backing_up', 'deleting')
                    AND updated_at < now() - interval '45 minutes'))
          RETURNING id`,
        [jobId],
      );
      if (!(claimed[0]?.length ?? claimed.length)) return;
      let job = await repo.findOneOrFail({ where: { id: jobId } });

      if (job.backupRequired && !job.finalBackupId) {
        const backup = await this.buildFinalBackup(job);
        await repo.update(
          { id: jobId },
          { finalBackupId: backup.id, status: 'deleting' },
        );
        job = await repo.findOneOrFail({ where: { id: jobId } });
      }

      const result = await this.purge(job);
      await repo.update(
        { id: jobId },
        {
          status: 'done',
          rowCounts: result.rowCounts,
          usersDeleted: result.usersDeleted,
          membershipsRemoved: result.membershipsRemoved,
          ownerEmailHash: result.ownerEmailHash,
          filesDeleted: result.filesDeleted,
          filesFailed: result.filesFailed,
          finishedAt: new Date(),
        },
      );
      this.logger.log(
        `Company ${job.companyId} (${job.companyName}) deleted: ` +
          `${Object.values(result.rowCounts).reduce((a, b) => a + b, 0)} rows, ` +
          `${result.filesDeleted} files, ${result.usersDeleted} users`,
      );
    } catch (err) {
      const message = (err as Error).message ?? 'Unknown error';
      this.logger.error(`deletion ${jobId} failed: ${message}`);
      await repo.update(
        { id: jobId },
        {
          status: 'failed',
          error: message.slice(0, 1000),
          finishedAt: new Date(),
        },
      );
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  /** The automatic final backup: the customer backup ZIP, kept by FinMatrix. */
  private async buildFinalBackup(job: CompanyDeletion) {
    const sink = await this.storage.putStream({
      bucket: FINAL_BACKUP_BUCKET,
      name: `${job.companyId}/${job.id}.zip`,
      mimeType: 'application/zip',
    });
    try {
      await this.builder.build({
        manager: this.dataSource.manager,
        companyId: job.companyId,
        exportId: job.id,
        asOf: businessToday(),
        includeXlsx: true,
        requestedBy: job.requestedBy,
        sink: sink.stream,
      });
      const { size } = await sink.done;
      const repo = this.dataSource.getRepository(PlatformFinalBackup);
      return repo.save(
        repo.create({
          deletionId: job.id,
          companyId: job.companyId,
          companyName: job.companyName,
          storageKey: sink.key,
          sizeBytes: String(size),
          expiresAt: new Date(
            Date.now() + deletionBackupRetentionDays() * 86_400_000,
          ),
        }),
      );
    } catch (err) {
      await sink.abort().catch(() => undefined);
      throw new Error(
        `The final backup could not be built, so nothing was deleted: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Remove the company and every row it owns, in ONE transaction, driven by
   * the registry. Verifies zero rows remain before committing.
   */
  private async purge(job: CompanyDeletion) {
    const companyId = job.companyId;
    const out = await this.dataSource.transaction(async (em) => {
      const locked: Array<{ id: string; created_by: string }> = await em.query(
        `SELECT id, created_by FROM companies WHERE id = $1 FOR UPDATE`,
        [companyId],
      );
      if (!locked.length) {
        throw new Error('The company no longer exists.');
      }
      const tables = await this.existingTables(em);
      const rowCounts = await this.countRows(em, companyId, tables);
      const fileKeys = await this.collectFileKeys(em, companyId, tables);
      const members = await this.memberPlan(em, companyId);
      const [owner] = await em.query(`SELECT email FROM users WHERE id = $1`, [
        locked[0].created_by,
      ]);

      if (job.allowNewTrial) {
        await this.releaseTrialClaims(em, {
          companyId,
          userIds: members.deleteUsers,
        });
      }

      // 1. Children with no FK to their parent go first, by parent.
      for (const c of childTables()) {
        if (c.cascade || !tables.has(c.table)) continue;
        const parts = [{ parent: c.parent, fk: c.fk }, ...(c.alsoVia ?? [])]
          .filter((v) => tables.has(v.parent))
          .map(
            (v) =>
              `${quote(v.fk)} IN (SELECT id FROM ${quote(v.parent)} WHERE company_id = $1)`,
          );
        if (parts.length) {
          await em.query(
            `DELETE FROM ${quote(c.table)} WHERE ${parts.join(' OR ')}`,
            [companyId],
          );
        }
      }

      // 2. Company tables, referencing tables before the ones they reference
      //    (children with ON DELETE CASCADE go with their parents).
      const order = await this.deleteOrder(
        em,
        companyTables()
          .map((t) => t.table)
          .filter((t) => tables.has(t)),
      );
      for (const table of order) {
        await em.query(`DELETE FROM ${quote(table)} WHERE company_id = $1`, [
          companyId,
        ]);
      }

      // 3. Files stored in Postgres go now; Cloudinary/disk after commit.
      const dbIds = fileKeys
        .filter((k) => k.startsWith('db:'))
        .map((k) => k.slice(3))
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      if (dbIds.length && tables.has('stored_files')) {
        await em.query(`DELETE FROM stored_files WHERE id = ANY($1::uuid[])`, [
          dbIds,
        ]);
      }

      // 4. Platform rows that mention the company: clear the reference.
      for (const p of platformTables()) {
        if (p.handling !== 'null-columns' || !tables.has(p.table)) continue;
        for (const col of p.columns ?? []) {
          await em.query(
            `UPDATE ${quote(p.table)} SET ${quote(col)} = NULL WHERE ${quote(col)} = $1`,
            [companyId],
          );
        }
      }

      // 5. People: delete those who belonged only here; re-point the rest.
      await this.deleteUsers(em, members.deleteUsers);
      await em.query(
        `UPDATE users u SET default_company_id = (
             SELECT m.company_id FROM user_companies m WHERE m.user_id = u.id LIMIT 1)
          WHERE u.default_company_id = $1`,
        [companyId],
      );

      // 6. The company row (trial_claims.company_id is set NULL by its FK).
      await em.query(`DELETE FROM companies WHERE id = $1`, [companyId]);

      // 7. Prove it: nothing registered still holds a row for this company.
      const left = await this.countRows(em, companyId, tables);
      const remaining = Object.entries(left).filter(([, n]) => n > 0);
      if (remaining.length) {
        throw new Error(
          `Rows remained after the purge: ${remaining.map(([t, n]) => `${t}=${n}`).join(', ')}`,
        );
      }

      const ownerEmailHash = emailHash(owner?.email);
      await this.audit.recordIn(em, {
        actorUserId: job.requestedBy,
        action: 'company_deleted',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: job.companyName,
        reason: job.reason,
        details: {
          deletionId: job.id,
          ownerEmailHash,
          rowCounts,
          totalRows: Object.values(rowCounts).reduce((a, b) => a + b, 0),
          files: fileKeys.length,
          usersDeleted: members.deleteUsers.length,
          membershipsRemoved: members.keepUsers.length,
          allowNewTrial: job.allowNewTrial,
          isDemo: job.isDemo,
          finalBackupId: job.finalBackupId,
        },
      });
      return {
        rowCounts,
        fileKeys,
        usersDeleted: members.deleteUsers.length,
        membershipsRemoved: members.keepUsers.length,
        ownerEmailHash,
      };
    });

    // After commit: files outside Postgres. Best-effort, counted.
    let filesDeleted = out.fileKeys.filter((k) => k.startsWith('db:')).length;
    let filesFailed = 0;
    for (const key of out.fileKeys) {
      if (key.startsWith('db:')) continue;
      try {
        await this.storage.remove(key);
        filesDeleted += 1;
      } catch {
        filesFailed += 1;
      }
    }
    return { ...out, filesDeleted, filesFailed };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async companyOrFail(companyId: string): Promise<Company> {
    const company = await this.dataSource
      .getRepository(Company)
      .findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private async existingTables(q: Q): Promise<Set<string>> {
    const rows: Array<{ table_name: string }> = await q.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    return new Set(rows.map((r) => r.table_name));
  }

  /** Rows each registered table holds for the company (children via parent). */
  async countRows(
    q: Q,
    companyId: string,
    tables?: Set<string>,
  ): Promise<Record<string, number>> {
    const present = tables ?? (await this.existingTables(q));
    const selects: string[] = [];
    for (const t of companyTables()) {
      if (!present.has(t.table)) continue;
      selects.push(
        `SELECT '${t.table}' AS t, count(*)::int AS n FROM ${quote(t.table)} WHERE company_id = $1`,
      );
    }
    for (const c of childTables()) {
      if (!present.has(c.table) || !present.has(c.parent)) continue;
      const parts = [{ parent: c.parent, fk: c.fk }, ...(c.alsoVia ?? [])]
        .filter((v) => present.has(v.parent))
        .map(
          (v) =>
            `${quote(v.fk)} IN (SELECT id FROM ${quote(v.parent)} WHERE company_id = $1)`,
        );
      selects.push(
        `SELECT '${c.table}' AS t, count(*)::int AS n FROM ${quote(c.table)} WHERE ${parts.join(' OR ')}`,
      );
    }
    const rows: Array<{ t: string; n: number }> = await q.query(
      selects.join(' UNION ALL '),
      [companyId],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.t] = Number(r.n);
    return out;
  }

  private async collectFileKeys(
    q: Q,
    companyId: string,
    tables: Set<string>,
  ): Promise<string[]> {
    const keys = new Set<string>();
    for (const { table, column } of COMPANY_FILE_COLUMNS) {
      if (!tables.has(table)) continue;
      const rows: Array<{ k: string }> = await q.query(
        `SELECT ${quote(column)} AS k FROM ${quote(table)}
          WHERE company_id = $1 AND ${quote(column)} IS NOT NULL AND ${quote(column)} <> ''`,
        [companyId],
      );
      for (const r of rows) keys.add(r.k);
    }
    return [...keys];
  }

  /** Who is deleted (this was their only company) and who just loses access. */
  private async memberPlan(q: Q, companyId: string) {
    const rows: Array<{ user_id: string; user_role: string; others: number }> =
      await q.query(
        `SELECT m.user_id, u.role AS user_role,
                (SELECT count(*)::int FROM user_companies o
                  WHERE o.user_id = m.user_id AND o.company_id <> $1) AS others
           FROM user_companies m JOIN users u ON u.id = m.user_id
          WHERE m.company_id = $1`,
        [companyId],
      );
    return {
      deleteUsers: rows
        .filter((r) => Number(r.others) === 0 && r.user_role !== 'super_admin')
        .map((r) => r.user_id),
      keepUsers: rows
        .filter((r) => Number(r.others) > 0 || r.user_role === 'super_admin')
        .map((r) => r.user_id),
    };
  }

  private async postedEntryCount(q: Q, companyId: string): Promise<number> {
    const [row] = await q.query(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE company_id = $1 AND status <> 'draft'`,
      [companyId],
    );
    return Number(row?.n ?? 0);
  }

  /** Delete users and everything that is only theirs. */
  private async deleteUsers(em: EntityManager, userIds: string[]) {
    if (!userIds.length) return;
    const params = [userIds];
    for (const table of [
      'refresh_tokens',
      'revoked_access_tokens',
      'email_verifications',
      'password_resets',
      'password_reset_otps',
      'notifications',
    ]) {
      await em.query(
        `DELETE FROM ${quote(table)} WHERE user_id = ANY($1::uuid[])`,
        params,
      );
    }
    // user_companies and managed_credentials cascade; trial_claims.user_id
    // is set NULL by its FK (the email/phone keys stay unless released).
    await em.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, params);
  }

  /**
   * "Allow a new free trial for this email and phone": release the claims so
   * the identities may trial again. A claim BLOCKED for abuse stays blocked.
   */
  private async releaseTrialClaims(
    em: EntityManager,
    opts: { companyId?: string; userIds?: string[] },
  ) {
    await em.query(
      `UPDATE trial_claims
          SET status = 'released', release_reason = 'account_deleted',
              decided_at = now(), updated_at = now()
        WHERE status IN ('pending', 'approved', 'granted')
          AND (company_id = $1 OR user_id = ANY($2::uuid[]))`,
      [opts.companyId ?? null, opts.userIds ?? []],
    );
  }

  /**
   * Order company tables so a table is deleted before any table it references
   * with a NO ACTION / RESTRICT foreign key. (Today every such key cascades or
   * sets null, so this is defence for the future.)
   */
  private async deleteOrder(q: Q, names: string[]): Promise<string[]> {
    const edges: Array<{ child: string; parent: string }> = await q.query(
      `SELECT cl.relname AS child, pl.relname AS parent
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_class pl ON pl.oid = c.confrelid
        WHERE c.contype = 'f' AND c.confdeltype IN ('a', 'r')
          AND cl.relname = ANY($1) AND pl.relname = ANY($1)
          AND cl.relname <> pl.relname`,
      [names],
    );
    const blockedBy = new Map<string, Set<string>>();
    for (const e of edges) {
      // parent must wait until child is gone
      if (!blockedBy.has(e.parent)) blockedBy.set(e.parent, new Set());
      blockedBy.get(e.parent)!.add(e.child);
    }
    const done = new Set<string>();
    const order: string[] = [];
    const visit = (t: string, path: Set<string>) => {
      if (done.has(t)) return;
      if (path.has(t)) return; // cycle: fall back to registry order
      path.add(t);
      for (const c of blockedBy.get(t) ?? []) visit(c, path);
      path.delete(t);
      done.add(t);
      order.push(t);
    };
    for (const t of names) visit(t, new Set());
    return order;
  }
}
