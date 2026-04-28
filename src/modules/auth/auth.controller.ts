import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import {
  ForgotPasswordDto,
  RefreshTokenDto,
  ResetPasswordDto,
  SigninDto,
} from './dto/signin.dto';
import { PublicRoute } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @PublicRoute()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Register a new user (admin or delivery).' })
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Post('signin')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Authenticate with email + password.' })
  signin(@Body() dto: SigninDto) {
    return this.auth.signin(dto);
  }

  @Post('forgot-password')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @ApiOperation({ summary: 'Request password reset link.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Post('reset-password')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiOperation({ summary: 'Validate reset token and set a new password.' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Post('refresh-token')
  @PublicRoute()
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a valid refresh token for a new pair.' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return current user profile + company memberships.' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.getMe(user.id);
  }

  @Post('signout')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke all active refresh tokens for this user.' })
  signout(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.signout(user.id);
  }

  @Post('verify-email')
  @PublicRoute()
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify user email with token.' })
  verifyEmail(@Body('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  @Post('resend-verification')
  @PublicRoute()
  @HttpCode(200)
  @ApiOperation({ summary: 'Resend verification email.' })
  resendVerification(@Body('email') email: string) {
    return this.auth.resendVerification(email);
  }

  @Get('check-verification')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if current user email is verified.' })
  checkVerification(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.checkVerification(user.id);
  }
}
