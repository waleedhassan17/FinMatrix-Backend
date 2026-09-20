import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * An edit to one plan in the catalogue.
 *
 * Every field is optional and only what is sent is applied, so the console can
 * change a price without restating the rider limit.
 *
 * Amounts are in MINOR UNITS (paisa), matching plan-config and the payment
 * submission path. The console converts; the wire format never carries a
 * decimal rupee amount, because rounding one of those into paisa is how a
 * customer gets charged a rupee more than they were quoted.
 *
 * This replaces `Partial<CreateSubscriptionPlanDto>`, which was a TypeScript
 * type rather than a class -- so ValidationPipe saw `Object` as the metatype
 * and performed no validation or whitelisting on this route at all.
 */
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  /** Per-month price in paisa. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyMinorUnits?: number;

  /** TOTAL charged up front for the whole duration, in paisa. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMinorUnits?: number;

  /** Max simultaneously-active riders. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryPersonnelLimit?: number;

  /**
   * false retires the plan: nobody new is offered it, everybody already on it
   * keeps working. This is the safe alternative to deleting one.
   */
  @IsOptional()
  @IsBoolean()
  isOffered?: boolean;
}
