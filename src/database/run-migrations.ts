/**
 * Release-phase migration runner for Heroku / any container platform.
 *
 * Run with:
 *   node dist/database/run-migrations.js
 *
 * Exits 0 on success, non-zero on failure so the platform will halt the deploy.
 */
import { AppDataSource } from './data-source';

async function main() {
  // eslint-disable-next-line no-console
  console.log('[migrations] initializing datasource...');
  await AppDataSource.initialize();
  try {
    // eslint-disable-next-line no-console
    console.log('[migrations] running pending migrations...');
    const applied = await AppDataSource.runMigrations({ transaction: 'each' });
    if (applied.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[migrations] nothing to apply. schema up to date.');
    } else {
      // eslint-disable-next-line no-console
      console.log(`[migrations] applied ${applied.length}:`);
      for (const m of applied) {
        // eslint-disable-next-line no-console
        console.log(`  - ${m.name}`);
      }
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrations] FAILED:', err);
  process.exit(1);
});
