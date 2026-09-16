import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { CreditOverride } from '../utils/credit-control.util';

/**
 * The owner's instruction to let one sale go past a customer's credit limit.
 * Only honoured for the owner (role admin); the reason is audited.
 */
export class CreditOverrideDto {
  @ApiProperty({ example: 'Long-standing customer; cheque promised Friday.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

/** Turn the request's override into one the credit check can trust. */
export function creditOverrideFrom(
  dto: CreditOverrideDto | null | undefined,
  user: AuthenticatedUser,
): CreditOverride | null {
  if (!dto?.reason) return null;
  return { reason: dto.reason, userId: user.id, role: user.role };
}
