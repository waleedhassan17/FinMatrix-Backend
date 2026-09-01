import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { PASSWORD_REGEX } from './signup.dto';

export class SigninDto {
  /**
   * Username OR email. Preferred over `email` below, which is kept only so
   * already-installed app builds keep signing in — they post `email` and know
   * nothing about usernames. At least one of the two must be present; the
   * service enforces that, since class-validator cannot express "either".
   */
  @ApiPropertyOptional({ example: 'warehouse.staff' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  identifier?: string;

  // Deliberately NOT @IsEmail anymore: an old client may post a username here.
  @ApiPropertyOptional({ example: 'admin@finmatrix.pk' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  email?: string;

  @ApiProperty({ example: 'Admin123!' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class ForgotPasswordDto {
  /**
   * Email, or a username. Not @IsEmail: a staff member who types their
   * username here was getting a 400 reading "email must be an email", which
   * explains nothing. Accepting the string lets the service answer with
   * something actionable instead — see AuthService.forgotPassword.
   */
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsString()
  @MinLength(1)
  email!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 numeric digits' })
  otp!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'Single-use token returned by /auth/verify-otp' })
  @IsString()
  @MinLength(1)
  resetToken!: string;

  @ApiProperty({ example: 'Admin123!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(PASSWORD_REGEX, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
  email!: string;
}
