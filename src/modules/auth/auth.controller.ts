import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import {
  ForgotPasswordDto,
  RefreshTokenDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SigninDto,
  VerifyOtpDto,
} from './dto/signin.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
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
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
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

  // ── Forgot password (OTP flow) ──────────────────────────────────────────

  @Post('forgot-password')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @ApiOperation({ summary: 'Request a password-reset OTP by email.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Post('verify-otp')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Verify the password-reset OTP, returns a reset token.' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @Post('reset-password')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiOperation({ summary: 'Set a new password using the reset token.' })
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

  // ── Email verification ──────────────────────────────────────────────────

  @Post('verify-email')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Verify user email with a deep-link token (app).' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @ApiOperation({ summary: 'Resend the verification email (rate limited).' })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  /**
   * Web fallback page used when the verification email is opened on a device
   * where the app is not installed. Verifies the token server-side and renders
   * a small HTML page with a button to open the app via its custom scheme.
   */
  @Get('verify')
  @PublicRoute()
  @ApiOperation({ summary: 'Web fallback page for email verification.' })
  async verifyEmailWeb(@Query('token') token: string, @Res() res: Response) {
    let ok = false;
    try {
      await this.auth.verifyEmail(token);
      ok = true;
    } catch {
      ok = false;
    }
    const deepLink = `finmatrix://verify-email?token=${encodeURIComponent(token ?? '')}`;
    res.type('html').send(renderFallbackPage(ok, deepLink));
  }
}

function renderFallbackPage(ok: boolean, deepLink: string): string {
  const title = ok ? 'Email verified ✅' : 'Verification failed';
  const message = ok
    ? 'Your email has been verified. Open the FinMatrix app to continue setting up your company.'
    : 'This verification link is invalid, already used, or expired. Open the app and request a new link.';
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FinMatrix — Email verification</title></head>
<body style="margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1f2937;">
  <div style="max-width:480px;margin:48px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center;">
    <h1 style="font-size:20px;">${title}</h1>
    <p style="color:#4b5563;">${message}</p>
    <a href="${deepLink}" style="display:inline-block;margin-top:16px;background:#1f6feb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Open FinMatrix app</a>
  </div>
</body></html>`;
}
