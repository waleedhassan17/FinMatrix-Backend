import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 * The eight actions a staff member may ask for but not perform.
 *
 * Seven of them move value out or correct the ledger (§0 Table A). The eighth,
 * `delivery_undo`, reverses an approved delivery — the owner's call because it
 * unwinds recognised revenue.
 */
export type ApprovalType =
  | 'adjustment'
  | 'journal'
  | 'credit_memo'
  | 'vendor_credit'
  | 'void'
  | 'bill_payment'
  | 'po'
  | 'delivery_undo';

export const APPROVAL_TYPES: ApprovalType[] = [
  'adjustment',
  'journal',
  'credit_memo',
  'vendor_credit',
  'void',
  'bill_payment',
  'po',
  'delivery_undo',
];

/**
 * `approving` is a claim, not a resting state: see ApprovalsService.decide.
 * A row sits in it only for the duration of one dispatch.
 */
export type ApprovalStatus =
  | 'pending'
  | 'approving'
  | 'approved'
  | 'rejected'
  | 'cancelled';

/**
 * A staff member's request for an action only the owner may perform.
 *
 * The whole point of this row is that it does NOTHING until approved. Creating
 * it writes no general-ledger rows, no journal entry, no purchase order —
 * `payload` is the untouched request body, replayed against the owning service
 * at the moment the owner says yes. That is what makes a pending request safe:
 * there is nothing to unwind if it is rejected or cancelled.
 */
@Entity('approval_requests')
@Index(['companyId', 'status'])
@Index(['companyId', 'requestedBy'])
export class ApprovalRequest extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 32 })
  type!: ApprovalType;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: ApprovalStatus;

  /** The original request body, replayed verbatim on approval. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** Human-readable one-liner for the inbox, built at request time. */
  @Column({ type: 'text' })
  summary!: string;

  /**
   * Why the requester wants this. Required for delivery_undo, where the owner
   * is being asked to reverse revenue and deserves to know what happened.
   */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid', name: 'requested_by' })
  requestedBy!: string;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewedBy!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'reviewer_role' })
  reviewerRole!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewedAt!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'reviewer_comment' })
  reviewerComment!: string | null;

  /** The journal entry the approval posted, when the action posts one. */
  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  /** The document the approval created (PO, credit memo, payment, …). */
  @Column({ type: 'uuid', nullable: true, name: 'result_id' })
  resultId!: string | null;

  /**
   * Why the last approval attempt failed — a closed period, insufficient
   * stock, a since-paid bill. Kept so the owner sees the reason on the row
   * rather than only in a toast that has already gone.
   */
  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError!: string | null;
}
