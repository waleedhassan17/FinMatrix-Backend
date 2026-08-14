import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsPkPhone } from '../../../common/validation/phone';

export const LEGAL_STRUCTURES = [
  'sole_proprietor',
  'llc',
  'partnership',
  'corporation',
] as const;

/**
 * Accrual is the only basis FinMatrix reports on.
 *
 * Every financial statement is derived from general_ledger, which records
 * revenue at invoice date and expense at bill date — that is accrual by
 * construction. 'cash' was accepted here and stored on the company, but
 * reports.service.ts never read the column, so choosing it changed nothing
 * (audit gap G8). A toggle that silently does nothing is worse than no
 * toggle: it tells the owner their P&L is on a basis it is not.
 *
 * Cash-basis reporting means a recognition switch in the report queries, not
 * a new value here.
 */
export const ACCOUNTING_METHODS = ['accrual'] as const;

/**
 * WAREHOUSE-ONLY BUILD — the single company type new registrations may use.
 * Mirrors DEFAULT_COMPANY_TYPE in the app's utils/featureGates.ts.
 */
export const WAREHOUSE_ONLY_COMPANY_TYPE = 'warehouse';

class AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() street?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
}

export class CreateCompanyDto {
  @ApiProperty({ example: 'Ali Traders' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() industry?: string;

  @ApiPropertyOptional({ enum: LEGAL_STRUCTURES })
  @IsOptional()
  @IsIn(LEGAL_STRUCTURES as unknown as string[])
  legalStructure?: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({
    example: '042-35761234',
    description:
      'Pakistani mobile or landline. Accepts local (042-35761234, 03124890176) ' +
      'and international (+92…) forms; stored as +92XXXXXXXXXX.',
  })
  @IsOptional()
  @IsString()
  @IsPkPhone({ allowLandline: true })
  phone?: string;

  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;

  @ApiPropertyOptional({ example: 'https://acme.pk' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;

  @ApiPropertyOptional({ description: 'Fiscal year start month, 1-12', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;

  @ApiPropertyOptional({
    enum: ACCOUNTING_METHODS,
    default: 'accrual',
    description: 'Accrual only — see ACCOUNTING_METHODS.',
  })
  @IsOptional()
  @IsIn(ACCOUNTING_METHODS as unknown as string[])
  accountingMethod?: string;

  @ApiPropertyOptional({ example: 'PKR' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  homeCurrency?: string;

  @ApiPropertyOptional({ description: 'URL or base64 logo string' })
  @IsOptional()
  @IsString()
  logo?: string;

  // ══ WAREHOUSE-ONLY BUILD ═══════════════════════════════════════════════
  // Every new company is created as `warehouse`, whatever the client sends.
  // Coerced rather than rejected so older app builds (and anything hitting
  // the API directly) keep working instead of hard-failing on registration.
  //
  // Existing small_business / large_org companies are untouched: FEATURE_MAP
  // still carries their rows, so their sessions resolve exactly as before.
  //
  // To restore the three-tier model, drop the @Transform and re-open the
  // enum below — see WAREHOUSE_ONLY_BUILD in the app's utils/featureGates.ts.
  @ApiPropertyOptional({
    enum: ['warehouse'],
    description:
      'Warehouse-only build: any value sent here is coerced to "warehouse".',
  })
  @IsOptional()
  @Transform(() => WAREHOUSE_ONLY_COMPANY_TYPE)
  @IsIn([WAREHOUSE_ONLY_COMPANY_TYPE])
  // Three-tier model (FinMatrix.md): decides the feature set and which two
  // subscription plans are offered.
  // @IsIn(['small_business', 'large_org', 'warehouse'])
  companyType?: string;
}

export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {
  @ApiPropertyOptional({ description: 'Mark/dismiss the first-run setup checklist' })
  @IsOptional()
  @IsBoolean()
  setupCompleted?: boolean;

  // booksLockedUntil is deliberately NOT updatable here. Closing the books
  // goes through POST :companyId/period-close, which tier-gates the action and
  // stamps books_locked_at — the timestamp that makes a back-dated posting
  // detectable. Setting the lock through a generic field edit would skip both.

  @ApiPropertyOptional({
    description: 'GST/Sales-tax registered: reclaim input tax on bills to a recoverable asset (1300).',
  })
  @IsOptional()
  @IsBoolean()
  salesTaxRegistered?: boolean;

  @ApiPropertyOptional({
    description:
      'Large-organization per-company inventory opt-in (basic stock + COGS). Ignored for other company types.',
  })
  @IsOptional()
  @IsBoolean()
  inventoryEnabled?: boolean;
}

/**
 * G4: closing the books is a deliberate accounting act, not a field edit.
 * It goes through its own endpoint so it can be tier-gated by `periodClose`,
 * validated, and stamped with the time the lock was applied — which is what
 * makes back-dating detectable (see Company.booksLockedAt).
 */
export class ClosePeriodDto {
  @ApiProperty({
    example: '2026-07-31',
    description: 'Close the books through this date. Postings dated on or before it are rejected.',
  })
  @IsDateString()
  lockDate!: string;
}

export class JoinCompanyDto {
  @ApiProperty({ example: 'AB12CD' })
  @IsString()
  @MinLength(4)
  code!: string;
}
