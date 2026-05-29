import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';
import { PASSWORD_REGEX } from './signup.dto';

export class SigninDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Admin123!' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'admin@finmatrix.pk' })
  @IsEmail()
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
