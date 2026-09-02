import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PASSWORD_REGEX } from '../../auth/dto/signup.dto';

/**
 * Only these two roles are mintable through user management. `delivery` has
 * its own screen (it needs a personnel profile alongside the account) and
 * `super_admin` is a platform role that no company may grant itself — a plain
 * union here is what stops a crafted request from creating one.
 */
export type CompanyRole = 'admin' | 'staff';
export const COMPANY_ROLES: CompanyRole[] = ['admin', 'staff'];

/**
 * Usernames must not contain '@': that character is the discriminator
 * AuthService uses to decide whether a sign-in handle is an email or a
 * username, so allowing it here would make the two namespaces collide.
 */
const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const USERNAME_RULE =
  'Username must be 3-64 characters: lowercase letters, digits, dot, underscore or hyphen, starting with a letter or digit.';

export class CreateCompanyUserDto {
  @ApiProperty({ example: 'Ayesha Khan' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'warehouse.staff' })
  @IsString()
  @Matches(USERNAME_REGEX, { message: USERNAME_RULE })
  username!: string;

  @ApiProperty({ example: 'Staff123!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(PASSWORD_REGEX, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password!: string;

  @ApiProperty({ enum: COMPANY_ROLES, example: 'staff' })
  @IsIn(COMPANY_ROLES, { message: 'Role must be either admin or staff' })
  role!: CompanyRole;

  @ApiPropertyOptional({ example: 'ayesha@company.pk' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+923001234567' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;
}

export class UpdateCompanyUserRoleDto {
  @ApiProperty({ enum: COMPANY_ROLES, example: 'admin' })
  @IsIn(COMPANY_ROLES, { message: 'Role must be either admin or staff' })
  role!: CompanyRole;
}

export class ResetCompanyUserPasswordDto {
  /**
   * Omit to have the server generate a readable one. The owner reads the
   * result back to the account holder, so a generated password is the normal
   * path and an explicit one is the exception.
   */
  @ApiPropertyOptional({ example: 'Staff123!', minLength: 8 })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(PASSWORD_REGEX, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password?: string;
}
