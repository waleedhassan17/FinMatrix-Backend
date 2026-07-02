import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
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
}

/** Optional status filter for GET /admin/payment-submissions. */
export class ListSubmissionsQueryDto {
  @IsOptional()
  @IsIn(['submitted', 'approved', 'rejected'])
  status?: 'submitted' | 'approved' | 'rejected';
}
