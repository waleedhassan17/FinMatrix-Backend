import {
  Body,
  Controller,
  Get,
  Headers,
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

  // Public + self-authenticating (the service verifies the bearer token) so
  // sign-out is idempotent: an already-invalid/expired token still gets 200
  // and leaks nothing. A valid token revokes the user's refresh tokens and
  // denylists the access token's jti (immediate 401 on reuse). '/signout' is
  // kept as an alias for clients already calling it.
  @Post(['logout', 'signout'])
  @PublicRoute()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Sign out: revoke refresh tokens + denylist the access token. Idempotent.',
  })
  signout(@Headers('authorization') authorization?: string) {
    return this.auth.signoutByToken(authorization);
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
   * The API's own verification page. New emails link to the web app's verify
   * page instead (MailService.buildVerificationLinks); this stays for links
   * already sitting in inboxes, and for any client that still builds it.
   *
   * It no longer hands the token on to the app. The token is single-use and
   * this request has just spent it, so "Open FinMatrix app" used to deliver a
   * dead token and the app answered "Verification failed" about an email that
   * had just been verified. Both onward links now simply say "verified", and
   * the web app or the app re-reads the account to move on.
   */
  @Get('verify')
  @PublicRoute()
  @ApiOperation({ summary: 'Web fallback page for email verification.' })
  async verifyEmailWeb(@Query('token') token: string, @Res() res: Response) {
    let outcome: FallbackOutcome = 'failed';
    try {
      const result = await this.auth.verifyEmail(token);
      outcome = result.alreadyVerified ? 'already' : 'verified';
    } catch {
      outcome = 'failed';
    }
    res.type('html').send(renderFallbackPage(outcome, this.auth.verificationOnwardLinks()));
  }
}

type FallbackOutcome = 'verified' | 'already' | 'failed';

function renderFallbackPage(
  outcome: FallbackOutcome,
  links: { web: string; signIn: string; app: string },
): string {
  const ok = outcome !== 'failed';
  const title = ok ? 'Email verified ✅' : 'This link has expired';
  const message =
    outcome === 'verified'
      ? 'Your email address is confirmed. Continue to set up your company.'
      : outcome === 'already'
        ? 'Your email address was already confirmed. Continue to set up your company.'
        : 'This verification link has expired or been replaced by a newer one. Sign in and we will send you a fresh link.';
  const primary = ok ? 'Continue on the web' : 'Sign in';
  const btn =
    'display:inline-block;margin-top:12px;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;';
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FinMatrix — Email verification</title></head>
<body style="margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1f2937;">
  <div style="max-width:480px;margin:48px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center;">
    <h1 style="font-size:20px;">${title}</h1>
    <p style="color:#4b5563;">${message}</p>
    <a href="${ok ? links.web : links.signIn}" style="${btn}background:#1f4e79;color:#fff;">${primary}</a><br/>
    <a href="${links.app}" style="${btn}background:#fff;color:#1f4e79;border:1px solid #d3dae3;">Open the FinMatrix app</a>
  </div>
</body></html>`;
}
