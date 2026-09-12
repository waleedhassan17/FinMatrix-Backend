import { UserRole } from '../../types';

/**
 * The sign-in doors a client can name when it posts /auth/signin.
 *
 * - `admin`    the business owner door (web and app). Super-admins use it too:
 *              the app routes them to the platform console after sign-in.
 * - `staff`    the web's team member door.
 * - `delivery` a rider-only door.
 * - `team`     the app's User Portal, which serves staff and riders from one
 *              form (its Staff / Delivery tab only changes the wording).
 */
export const SIGNIN_PORTALS = ['admin', 'staff', 'delivery', 'team'] as const;
export type SigninPortal = (typeof SIGNIN_PORTALS)[number];

export const PORTAL_ROLES: Record<SigninPortal, readonly UserRole[]> = {
  admin: ['admin', 'super_admin'],
  staff: ['staff'],
  delivery: ['delivery'],
  team: ['staff', 'delivery'],
};

export const isRoleAllowedOnPortal = (
  portal: SigninPortal,
  role: UserRole,
): boolean => PORTAL_ROLES[portal].includes(role);

/** Where this account signs in instead — shown only after the password matched. */
export function wrongPortalMessage(role: UserRole): string {
  switch (role) {
    case 'admin':
    case 'super_admin':
      return 'This is a business owner account. Sign in on the business owner portal with your email.';
    case 'staff':
      return 'This is a team member account. Sign in on the team member portal with your username.';
    case 'delivery':
      return 'This is a delivery rider account. Riders sign in on the FinMatrix Android app.';
    default:
      return 'This account cannot sign in here.';
  }
}
