import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  DEMO_BUSINESS_TYPES,
  DEMO_CURRENT_SYSTEMS,
  DEMO_STATUSES,
  DEMO_TEAM_SIZES,
  type DemoStatus,
} from '../entities/demo-request.entity';

export class BookDemoDto {
  @IsString()
  @Length(2, 80)
  fullName!: string;

  @IsString()
  @Length(2, 120)
  businessName!: string;

  /** Normalised to +92… by the service; invalid → DEMO_INVALID_PHONE. */
  @IsString()
  @Length(7, 24)
  phone!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(2, 80)
  city!: string;

  @IsIn(DEMO_BUSINESS_TYPES)
  businessType!: string;

  @IsOptional()
  @IsIn(DEMO_TEAM_SIZES)
  teamSize?: string;

  @IsOptional()
  @IsIn(DEMO_CURRENT_SYSTEMS)
  currentSystem?: string;

  /** One of the slot instants GET /public/demo-slots offered (ISO, UTC). */
  @IsDateString()
  slot!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  @IsBoolean()
  @Equals(true, { message: 'Please agree to be contacted about your demo.' })
  consent!: boolean;

  /** Honeypot: hidden from people, filled by bots. Must stay empty. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  formToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  turnstileToken?: string;

  @IsOptional()
  @IsObject()
  utm?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  landingPath?: string;
}

export class DemoStatusDto {
  @IsIn(DEMO_STATUSES)
  status!: DemoStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DemoScheduleDto {
  @IsDateString()
  scheduledAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingLink?: string;
}

export class DemoNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class DemoAssignDto {
  @IsOptional()
  @IsUUID()
  userId?: string | null;
}

export class DemoLinkCompanyDto {
  @IsUUID()
  companyId!: string;
}

export class DemoListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() businessType?: string;
  @IsOptional() @IsString() currentSystem?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) page?: number;
  @IsOptional() @Type(() => Number) limit?: number;
}
