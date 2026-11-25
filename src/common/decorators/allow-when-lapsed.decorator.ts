import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_LAPSED_KEY = 'allowWhenLapsed';

/**
 * Lets the OWNER of a company whose free trial ended (or whose plan expired)
 * through CompanyGuard on this route — and nobody else, and never a suspended
 * company. Data ownership must not depend on paying, so the owner can still
 * download a full backup and look at (or undo) a migration; everything else
 * stays blocked until the plan is switched on again.
 *
 * Whitelist, deliberately short:
 *   data-portability: create / list / read an export (download is a signed link)
 *   migrations:      list / read a batch, its certificate, and rollback
 */
export const AllowWhenLapsed = () => SetMetadata(ALLOW_WHEN_LAPSED_KEY, true);
