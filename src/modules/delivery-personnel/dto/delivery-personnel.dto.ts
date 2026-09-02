import { IsString, IsOptional, IsBoolean, IsEnum, IsNumberString, IsArray, IsUUID, Length, IsNumber, IsEmail, Matches, MinLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryPersonnelStatus } from '../../../types';
import { IsPkPhone } from '../../../common/validation/phone';

/**
 * Same rule as team usernames (settings/dto/company-user.dto.ts): no '@',
 * because that character is what AuthService uses to tell a username from an
 * email when resolving a sign-in handle.
 */
const RIDER_USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const RIDER_USERNAME_RULE =
  'Username must be 3-64 characters: lowercase letters, digits, dot, underscore or hyphen, starting with a letter or digit.';

/**
 * Riders sign in with a username and a password — always both, never an email.
 * They do not sign themselves up: the owner or a staff member creates the
 * account here and hands the credentials over, so these two fields are
 * required. `@ValidateIf(o => !o.userId)` keeps the older path working, where
 * a profile is attached to a user account that already exists.
 */
export class CreatePersonnelDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;

  @ApiProperty({ example: 'rider.imran' })
  @ValidateIf(o => !o.userId)
  @IsString()
  @Matches(RIDER_USERNAME_REGEX, { message: RIDER_USERNAME_RULE })
  username!: string;

  @ApiProperty({ example: 'Rider123!', minLength: 8 })
  @ValidateIf(o => !o.userId)
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  /** Optional contact detail only — never a sign-in handle for a rider. */
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional({ example: '03124890176' })
  @IsOptional()
  @IsString()
  @IsPkPhone({ allowLandline: true })
  phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() zones?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxLoad?: string;
}

export class UpdatePersonnelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() zones?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxLoad?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['active', 'on_leave', 'inactive'] as DeliveryPersonnelStatus[]) status?: DeliveryPersonnelStatus;
}

export class UpdateLocationDto {
  @ApiProperty({ description: 'GPS latitude' }) @IsNumber() lat!: number;
  @ApiProperty({ description: 'GPS longitude' }) @IsNumber() lng!: number;
  @ApiPropertyOptional({ description: 'Compass heading (degrees)' }) @IsOptional() @IsNumber() heading?: number;
  @ApiPropertyOptional({ description: 'Speed (m/s)' }) @IsOptional() @IsNumber() speed?: number;
  @ApiPropertyOptional({ description: 'GPS accuracy (meters)' }) @IsOptional() @IsNumber() accuracy?: number;
  @ApiPropertyOptional({ description: 'Client-side timestamp (epoch ms)' }) @IsOptional() @IsNumber() timestamp?: number;
}
