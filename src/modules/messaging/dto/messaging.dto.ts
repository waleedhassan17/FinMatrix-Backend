import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MESSAGE_EVENTS } from '../messaging.constants';

/** PUT /settings/messaging — every field optional; nested shapes are checked in the service. */
export class UpdateMessagingSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiPropertyOptional({ enum: ['shared', 'own'] })
  @IsOptional()
  @IsIn(['shared', 'own'])
  senderMode?: 'shared' | 'own';

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  phoneNumberId?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  wabaId?: string | null;

  @ApiPropertyOptional({
    description:
      'Write-only. Stored encrypted; never returned. Empty clears it.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2048)
  accessToken?: string | null;

  @ApiPropertyOptional({ enum: ['en', 'ur'] })
  @IsOptional()
  @IsIn(['en', 'ur'])
  defaultLanguage?: 'en' | 'ur';

  @ApiPropertyOptional({ description: 'event -> auto | manual | off' })
  @IsOptional()
  @IsObject()
  eventRules?: Record<string, string>;

  @ApiPropertyOptional({
    example: { start: '21:00', end: '09:00' },
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  quietHours?: { start: string; end: string } | null;

  @ApiPropertyOptional({
    example: { beforeDue: [3], afterDue: [0, 7, 15, 30] },
  })
  @IsOptional()
  @IsObject()
  reminderSchedule?: { beforeDue: number[]; afterDue: number[] };

  @ApiPropertyOptional({
    nullable: true,
    description: 'Messages per month; empty for no cap.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  monthlyCap?: number | null;
}

const DOC_TYPES = [
  'invoice',
  'payment',
  'purchase_order',
  'bill_payment',
  'customer_statement',
] as const;

export class TimelineQueryDto {
  @ApiProperty({
    enum: [...DOC_TYPES, 'bill_settlement', 'approval_request', 'delivery'],
  })
  @IsString()
  @MaxLength(32)
  docType!: string;

  @ApiProperty() @IsUUID() docId!: string;
}

export class SendMessageDto {
  @ApiProperty({ enum: DOC_TYPES })
  @IsIn(DOC_TYPES as unknown as string[])
  docType!: string;
  @ApiProperty() @IsUUID() docId!: string;

  @ApiPropertyOptional({
    enum: [...MESSAGE_EVENTS, 'reminder'],
    description:
      "Invoice: 'invoice_issued' sends the invoice; 'reminder' (default) a payment reminder.",
  })
  @IsOptional()
  @IsIn([...MESSAGE_EVENTS, 'reminder'])
  event?: string;

  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
}

export class ManualShareDto {
  @ApiProperty({ enum: DOC_TYPES })
  @IsIn(DOC_TYPES as unknown as string[])
  docType!: string;
  @ApiProperty() @IsUUID() docId!: string;
  @ApiProperty({ example: '0300 1234567' })
  @IsString()
  @MaxLength(32)
  toPhone!: string;

  @ApiPropertyOptional({ enum: MESSAGE_EVENTS })
  @IsOptional()
  @IsIn(MESSAGE_EVENTS as unknown as string[])
  event?: string;
}

export class StatsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

export class ContactHealthQueryDto {
  @ApiPropertyOptional({ enum: ['customer', 'vendor'] })
  @IsOptional()
  @IsIn(['customer', 'vendor'])
  partyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() partyId?: string;
}
