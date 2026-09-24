import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Please verify your email address first. Open the link we emailed you.';

/**
 * Refuses a session whose owner has not confirmed their email address.
 *
 * Signup and sign-in both hand an unverified owner a session, so the client can
 * sit on its verify screen and move on by itself the moment the link is opened.
 * That session must reach nothing else: no company can be created, joined or
 * submitted under an address nobody has proven they own, and no business
 * endpoint may serve it. Sign-in used to be the only check, and the token
 * signup returns walked straight past it.
 *
 * Only an explicit `false` refuses — see AuthenticatedUser.emailVerified.
 */
export function assertEmailVerified(
  user: Pick<AuthenticatedUser, 'emailVerified'> | null | undefined,
): void {
  if (user?.emailVerified === false) {
    throw new ForbiddenException({
      code: 'EMAIL_NOT_VERIFIED',
      message: EMAIL_NOT_VERIFIED_MESSAGE,
    });
  }
}
