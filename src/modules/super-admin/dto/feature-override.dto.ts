import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

/**
 * Super-admin feature override (FinMatrix.md SAFETY §4). All fields optional —
 * send only what you want to change.
 */
export class FeatureOverrideDto {
  @ApiPropertyOptional({
    description:
      'KILL SWITCH: true bypasses every feature gate for this company regardless of type/plan.',
  })
  @IsOptional()
  @IsBoolean()
  allFeaturesUnlocked?: boolean;

  @ApiPropertyOptional({ enum: ['small_business', 'large_org', 'warehouse'] })
  @IsOptional()
  @IsIn(['small_business', 'large_org', 'warehouse'])
  companyType?: string;

  @ApiPropertyOptional({ description: 'Large-org per-company inventory toggle.' })
  @IsOptional()
  @IsBoolean()
  inventoryEnabled?: boolean;
}
