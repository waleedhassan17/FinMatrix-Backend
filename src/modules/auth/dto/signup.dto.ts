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

export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;
export const PK_PHONE_REGEX = /^\+92-\d{2,3}-\d{7}$/;

export class SignupDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Admin123!', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  @Matches(PASSWORD_REGEX, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password!: string;

  @ApiProperty({ example: 'Ali Khan', minLength: 2 })
  @IsString()
  @MinLength(2, { message: 'Display name must be at least 2 characters' })
  displayName!: string;

  @ApiPropertyOptional({ example: '+92-300-1234567' })
  @IsOptional()
  @IsString()
  @Matches(PK_PHONE_REGEX, {
    message: 'Phone must match Pakistani format +92-XXX-XXXXXXX',
  })
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
