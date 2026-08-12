import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsPkPhone } from '../../../common/validation/phone';

export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

export class SignupDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
  email!: string;

  // Kept in step with ResetPasswordDto (min 8) — a shorter signup floor meant
  // a password could be created that could never be re-set to itself.
  @ApiProperty({ example: 'Admin123!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(PASSWORD_REGEX, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password!: string;

  @ApiProperty({ example: 'Ali Khan', minLength: 2 })
  @IsString()
  @MinLength(2, { message: 'Display name must be at least 2 characters' })
  displayName!: string;

  @ApiPropertyOptional({
    example: '03124890176',
    description:
      'Pakistani mobile. Accepts 03XXXXXXXXX, +923XXXXXXXXX or 923XXXXXXXXX ' +
      '(spaces/dashes allowed); stored as +923XXXXXXXXX.',
  })
  @IsOptional()
  @IsString()
  @IsPkPhone()
  phone?: string;

  @ApiProperty({ enum: ['admin', 'delivery'], example: 'admin' })
  @IsIn(['admin', 'delivery'])
  role!: 'admin' | 'delivery';

  @ApiPropertyOptional({
    description: 'Required only when role=delivery. Company invite code.',
    example: 'AB12CD',
  })
  @ValidateIf((o: SignupDto) => o.role === 'delivery')
  @IsString()
  @MinLength(4)
  companyCode?: string;
}
