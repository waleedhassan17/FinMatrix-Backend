import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EDITABLE_STATUSES } from './state-machine';

/** A batch untouched this long while still open is "stuck" for support. */
const STUCK_AFTER_DAYS = 3;

/** The reference the owner reads out to support (matches the clients). */
export function migrationReference(batchId: string): string {
  return `MIG-${batchId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** The file's extension, lower-case ('xlsx', 'xml', 'zip', …), or 'file'. */
function fileKind(name: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : 'file';
}

/**
 * Read-only Migration Center view for super-admins (support). Shows a batch's
 * status, readiness, issue counts by code, the hard checks' totals and
 * timestamps — never customer rows, file contents, file names or any amount
 * beyond the check totals.
 */
@Injectable()
export class MigrationAdminService {
  constructor(private readonly dataSource: DataSource) {}

  async list(filter: {
    companyId?: string;
    status?: string;
    stuck?: boolean;
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = ['true'];
    if (filter.companyId) where.push(`b.company_id = ${p(filter.companyId)}`);
    if (filter.status && filter.status !== 'all')
      where.push(`b.status = ${p(filter.status)}`);
    if (filter.stuck)
      where.push(
        `b.status = ANY(${p(EDITABLE_STATUSES)}) AND b.updated_at < now() - interval '${STUCK_AFTER_DAYS} days'`,
      );
    if (filter.q?.trim())
      where.push(`c.name ILIKE ${p(`%${filter.q.trim()}%`)}`);
    const from = `FROM migration_batches b LEFT JOIN companies c ON c.id = b.company_id
                  WHERE ${where.join(' AND ')}`;
    const [{ total }] = await this.dataSource.query(
      `SELECT count(*)::int AS total ${from}`,
      params,
    );
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT b.*, c.name AS company_name,
              (SELECT count(*)::int FROM migration_files f WHERE f.batch_id = b.id) AS files,
              (SELECT count(*)::int FROM migration_issues i
                WHERE i.batch_id = b.id AND i.resolved_at IS NULL) AS open_issues
         ${from}
        ORDER BY b.updated_at DESC
        LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`,
      params,
    );
    return {
      items: rows.map((r) => this.summary(r)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async detail(batchId: string) {
    const [r] = await this.dataSource.query(
      `SELECT b.*, c.name AS company_name,
              (SELECT count(*)::int FROM migration_files f WHERE f.batch_id = b.id) AS files,
              (SELECT count(*)::int FROM migration_issues i
                WHERE i.batch_id = b.id AND i.resolved_at IS NULL) AS open_issues
         FROM migration_batches b LEFT JOIN companies c ON c.id = b.company_id
        WHERE b.id = $1`,
      [batchId],
    );
    if (!r) throw new NotFoundException('Migration not found');
    const issues: Array<{
      code: string;
      severity: string;
      open: number;
      resolved: number;
    }> = await this.dataSource.query(
      `SELECT code, severity,
              count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
              count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved
         FROM migration_issues WHERE batch_id = $1
        GROUP BY code, severity ORDER BY open DESC, code`,
      [batchId],
    );
    const fileRows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT * FROM migration_files WHERE batch_id = $1`,
      [batchId],
    );
    const files = new Map<string, { kind: string; count: number }>();
    for (const f of fileRows) {
      const kind = fileKind(f.original_name ?? f.file_name ?? f.name);
      const entry = files.get(kind) ?? { kind, count: 0 };
      entry.count += 1;
      files.set(kind, entry);
    }
    const uploads: Array<{ status: string; n: number }> =
      await this.dataSource.query(
        `SELECT status, count(*)::int AS n FROM migration_uploads
          WHERE batch_id = $1 GROUP BY status`,
        [batchId],
      );
    return {
      ...this.summary(r),
      issuesByCode: issues,
      // The hard checks: their totals and outcome, never the row details.
      checks: (Array.isArray(r.checks) ? r.checks : []).map((c: any) => ({
        code: c.code,
        label: c.label,
        expected: c.expected,
        actual: c.actual,
        difference: c.difference,
        passed: c.passed,
      })),
      fileKinds: [...files.values()],
      uploads,
    };
  }

  async counts() {
    const [row] = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE status = ANY($1))::int AS in_progress,
         count(*) FILTER (WHERE status = ANY($1)
                           AND updated_at < now() - interval '${STUCK_AFTER_DAYS} days')::int AS stuck,
         count(*) FILTER (WHERE status = 'committed')::int AS committed
         FROM migration_batches`,
      [EDITABLE_STATUSES],
    );
    return {
      inProgress: row.in_progress,
      stuck: row.stuck,
      awaitingClose: row.committed,
    };
  }

  private summary(r: Record<string, any>) {
    const counts = r.counts ?? null;
    const open = (EDITABLE_STATUSES as readonly string[]).includes(r.status);
    return {
      id: r.id,
      reference: migrationReference(r.id),
      companyId: r.company_id,
      companyName: r.company_name ?? null,
      sourceSystem: r.source_system,
      cutoverDate: r.cutover_date,
      status: r.status,
      readiness: r.readiness,
      files: r.files ?? 0,
      openIssues: r.open_issues ?? 0,
      issueCounts: counts?.issues ?? null,
      checksPassed: Array.isArray(r.checks)
        ? r.checks.filter((c: any) => c.passed).length
        : null,
      checksTotal: Array.isArray(r.checks) ? r.checks.length : null,
      stuck:
        open &&
        new Date(r.updated_at).getTime() <
          Date.now() - STUCK_AFTER_DAYS * 86_400_000,
      aiCalls: r.ai_calls ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      signedOffAt: r.signed_off_at,
      committedAt: r.committed_at,
      closedAt: r.closed_at,
      rolledBackAt: r.rolled_back_at,
    };
  }
}
