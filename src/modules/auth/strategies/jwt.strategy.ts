import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { RevokedAccessToken } from '../entities/revoked-access-token.entity';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { UserRole } from '../../../types';

export interface JwtPayload {
  sub: string;
  companyId: string | null;
  role: UserRole;
  /** Token id — present on all newly issued tokens; keys the signout denylist. */
  jti?: string;
  /**
   * What the token is for. Absent on tokens issued before it existed; see
   * LEGACY_ACCESS_MAX_LIFETIME_S for how those are told apart.
   */
  typ?: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

/**
 * Before `typ` existed, access and refresh tokens were signed with the same
 * secret and carried the same claims, so a 30-day refresh token passed as an
 * access token. Legacy access tokens lived 15 minutes; legacy refresh tokens
 * 30 days. Anything without `typ` that was issued to live longer than a day is
 * therefore a refresh token and is refused here.
 */
const LEGACY_ACCESS_MAX_LIFETIME_S = 24 * 60 * 60;

/** True when the payload may be used as an access token. */
export function isAccessTokenPayload(payload: JwtPayload): boolean {
  if (payload.typ) return payload.typ === 'access';
  if (payload.exp != null && payload.iat != null) {
    return payload.exp - payload.iat <= LEGACY_ACCESS_MAX_LIFETIME_S;
  }
  return true;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    @InjectRepository(RevokedAccessToken)
    private readonly revokedAccessRepo: Repository<RevokedAccessToken>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
      ignoreExpiration: false,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // A refresh token is not a bearer credential for the API.
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }
    // Signed-out access tokens (denylisted jti) are rejected until they
    // expire. Tokens issued before jti existed have no jti and skip this.
    if (
      payload.jti &&
      (await this.revokedAccessRepo.exists({ where: { jti: payload.jti } }))
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: payload.role,
      companyId: payload.companyId,
      // Read off the row already loaded above, so enforcing verification costs
      // no query. Same rule sign-in used to gate on: only an owner with an
      // address to confirm can be unverified.
      emailVerified: !(
        user.role === 'admin' &&
        !!user.email &&
        !user.isEmailVerified
      ),
    };
  }
}
