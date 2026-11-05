import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * How a posting is delivered on WhatsApp (FinMatrix Connect).
 *   whatsapp: false  post only, send nothing
 *   whatsapp: true   send even when the event's rule is "Ask each time"
 *   omitted          follow the company's rule
 */
export class DeliverDto {
  @ApiPropertyOptional({
    description:
      'false = do not send; true = send even if the rule is "ask each time".',
  })
  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;
}
