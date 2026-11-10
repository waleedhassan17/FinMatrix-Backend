import { EntityManager } from 'typeorm';

/**
 * End every refresh session a user holds, so the next token rotation has to
 * go through sign-in again.
 *
 * Called whenever someone else changes what a user may do: removing them from
 * a company, changing their role, deactivating them, or resetting their
 * password for them. Access tokens still in flight are covered separately:
 * CompanyGuard re-reads membership and role on every request, and JwtStrategy
 * refuses inactive users.
 *
 * Runs on the caller's manager so it commits or rolls back with the change.
 */
export async function revokeRefreshTokens(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  await manager.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
