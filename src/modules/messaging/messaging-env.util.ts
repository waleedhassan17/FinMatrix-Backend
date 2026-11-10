import { ConfigService } from '@nestjs/config';
import { envFlag, envString } from '../../common/utils/env.util';

// The generic readers live in common/utils/env.util.ts (src/config uses them
// too); re-exported here so existing imports keep working.
export { envFlag, envString };

/** True only when real Meta calls are switched on. */
export const whatsappLive = (config: ConfigService | null) =>
  envFlag(config, 'WHATSAPP_ENABLED', false);

/** A production server: NODE_ENV=production, or any Heroku dyno. */
export const productionServer = (config: ConfigService | null) =>
  envString(config, 'NODE_ENV') === 'production' || Boolean(process.env.DYNO);

/**
 * Whether anything may be "sent" at all. The simulated sender is for
 * development and tests only: on a production server without
 * WHATSAPP_ENABLED=true, Connect cannot be switched on, no test message goes
 * out and the worker stays idle — nobody ever sees a "read" tick for a
 * message that never left.
 */
export const sendingAvailable = (config: ConfigService | null) =>
  whatsappLive(config) || !productionServer(config);

/** This process dispatches messages and runs the collections crons. */
export const messagingWorker = (config: ConfigService | null) =>
  envFlag(config, 'MESSAGING_WORKER_ENABLED', true) && sendingAvailable(config);
