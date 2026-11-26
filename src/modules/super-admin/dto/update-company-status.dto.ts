import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// Canonical Phase1.md model = pending | active | inactive | rejected.
// `suspended` is accepted as a legacy alias for `inactive`; both now SUSPEND
// the company (a reversible platform block, see AccountAdminService).
export type CompanyStatus =
  | 'pending'
  | 'active'
  | 'inactive'
  | 'suspended'
  | 'rejected';

/**
 * Plan terms a super-admin sets when switching a company on without a
 * payment. Approving a pending/draft/rejected company REQUIRES either these
 * (plan + end date) or `asTrial: true` — no approval may grant unlimited free
 * access again.
 */
export class PlanTermsDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  plan?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Approve as a free trial instead (only while the account is eligible). */
  @IsOptional()
  @IsBoolean()
  asTrial?: boolean;
}

export class UpdateCompanyStatusDto extends PlanTermsDto {
  @IsEnum(['pending', 'active', 'inactive', 'suspended', 'rejected'])
  status!: CompanyStatus;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejectionReason?: string;

  /** Why a company is suspended (inactive/suspended). */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
