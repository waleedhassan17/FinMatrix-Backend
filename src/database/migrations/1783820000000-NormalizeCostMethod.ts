import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G6 — weighted average is the only costing method that exists.
 *
 * cost_method accepted 'fifo' and 'lifo', the frontend defaulted the form to
 * FIFO, and nothing in the codebase ever read the value: every outflow values
 * stock at the item's running weighted-average unit_cost and there are no cost
 * layers to consume. Anyone who picked FIFO or LIFO got average behaviour under
 * a label that said otherwise, which misstates COGS and closing inventory.
 *
 * Normalise any stored value to 'average' so the column cannot contradict the
 * behaviour. Additive and idempotent; no rows are removed.
 */
export class NormalizeCostMethod1783820000000 implements MigrationInterface {
  name = 'NormalizeCostMethod1783820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "inventory_items"
         SET "cost_method" = 'average'
       WHERE "cost_method" IS DISTINCT FROM 'average'
    `);
  }

  public async down(): Promise<void> {
    // Irreversible by design: the previous values were labels over behaviour
    // that never existed, so there is nothing meaningful to restore.
  }
}
