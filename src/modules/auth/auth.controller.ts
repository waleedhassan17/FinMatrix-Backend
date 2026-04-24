import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Register a new user (admin or delivery).' })
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Post('signin')
  @PublicRoute()
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate with email + password.' })
  signin(@Body() dto: SigninDto) {
    return this.auth.signin(dto);
  }

  @Post('forgot-password')
  @PublicRoute()
  @HttpCode(200)
  @ApiOperation({ summary: 'Request password reset link.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Post('reset-password')
  @PublicRoute()
  @HttpCode(200)
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
}
