import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

// Canonical Phase1.md model = pending | active | inactive | rejected.
// `suspended` is accepted as a legacy alias for `inactive`.
export type CompanyStatus = 'pending' | 'active' | 'inactive' | 'suspended' | 'rejected';

export class UpdateCompanyStatusDto {
  @IsEnum(['pending', 'active', 'inactive', 'suspended', 'rejected'])
  status!: CompanyStatus;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejectionReason?: string;
}
