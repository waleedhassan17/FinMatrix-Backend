import { IsUUID, IsEnum, IsOptional, IsString, IsDateString } from 'class-validator';
import { SubscriptionStatus } from '../entities/company-subscription.entity';

export class AssignSubscriptionDto {
  @IsUUID()
  companyId!: string;

  @IsUUID()
  planId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;

  @IsEnum(['active', 'expired', 'cancelled', 'trial'])
  @IsOptional()
  status?: SubscriptionStatus;

  @IsString()
  @IsOptional()
  notes?: string;
}
