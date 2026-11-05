import { ConfigService } from '@nestjs/config';

/** Joi turns 'true'/'false' into booleans; process.env keeps strings. Accept both. */
export function envFlag(
  config: ConfigService | null,
  key: string,
  fallback: boolean,
): boolean {
  const raw: unknown = config?.get(key) ?? process.env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return fallback;
}

export function envString(config: ConfigService | null, key: string): string {
  const raw: unknown = config?.get(key) ?? process.env[key];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

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
