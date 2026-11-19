/**
 * Environment for test/migration-ai.acceptance.ts. Imported FIRST: the app's
 * ConfigModule validates process.env once, when AppModule is first imported.
 */
process.env.EXPORT_WORKER_ENABLED = 'false';
process.env.MESSAGING_WORKER_ENABLED = 'false';
for (const k of [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_URL',
])
  process.env[k] = '';
process.env.MIGRATION_AI_ENABLED = 'true';
process.env.MIGRATION_AI_MODEL =
  process.env.MIGRATION_AI_MODEL || 'claude-opus-5-5';
process.env.MIGRATION_AI_MAX_CALLS = '10';
export {};
