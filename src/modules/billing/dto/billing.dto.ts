import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PLAN_KEYS, PlanKey } from '../plan-config';

/** Body for POST /billing/submit (multipart, alongside the screenshot file). */
export class SubmitPaymentDto {
  @IsIn(PLAN_KEYS)
  plan!: PlanKey;
}

/** Query for GET /billing/bank-details?plan=. */
export class BankDetailsQueryDto {
  @IsIn(PLAN_KEYS)
  plan!: PlanKey;
}

/** Body for PATCH /admin/payment-submissions/:id/reject. */
export class RejectSubmissionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  /**
   * TRIAL requests only. false (default) releases the email/phone so the owner
   * may request again; true blocks future trials for them permanently.
   * Ignored for payment submissions.
   */
  @IsOptional()
  @IsBoolean()
  blockFutureTrials?: boolean;
}

/** Filters for GET /admin/payment-submissions. */
export class ListSubmissionsQueryDto {
  @IsOptional()
  @IsIn(['submitted', 'approved', 'rejected'])
  status?: 'submitted' | 'approved' | 'rejected';

  /** A specific kind, or PAYMENT for every non-trial submission. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['NEW', 'RENEWAL', 'UPGRADE', 'TRIAL', 'PAYMENT'])
  kind?: 'NEW' | 'RENEWAL' | 'UPGRADE' | 'TRIAL' | 'PAYMENT';

  /** Oldest-first suits the trial queue (activation is promised within 24h). */
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
