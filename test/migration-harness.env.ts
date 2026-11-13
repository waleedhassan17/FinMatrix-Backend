/**
 * Environment for test/migration-harness.ts. Imported FIRST, before anything
 * that loads AppModule: ConfigModule.forRoot reads .env and caches the
 * validated config when AppModule is first imported, so a value set later
 * (inside bootHarness, say) is never seen. Setting these after the import
 * once left a developer's Cloudinary credentials and the export worker live
 * in every harness run.
 *
 * Variables already present in process.env win over .env, an empty string
 * included, so blanking the Cloudinary keys here keeps uploads in Postgres.
 */
process.env.EXPORT_WORKER_ENABLED = 'false';
process.env.MESSAGING_WORKER_ENABLED = 'false';
process.env.EMAIL_ENABLED = 'false';
for (const k of [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_URL',
])
  process.env[k] = '';
export {};
