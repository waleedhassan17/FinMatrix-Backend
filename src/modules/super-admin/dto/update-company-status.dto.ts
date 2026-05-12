import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export type CompanyStatus = 'pending' | 'active' | 'suspended' | 'rejected';

export class UpdateCompanyStatusDto {
  @IsEnum(['pending', 'active', 'suspended', 'rejected'])
  status!: CompanyStatus;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejectionReason?: string;
}
