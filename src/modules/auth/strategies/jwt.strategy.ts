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
  iat?: number;
  exp?: number;
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
      role: payload.role,
      companyId: payload.companyId,
    };
  }
}
