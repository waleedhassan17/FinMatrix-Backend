import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A photo per inventory item.
 *
 * inventory_item_images holds the stored file's metadata — two StorageService
 * keys, because every upload is normalised into a large `display` JPEG and a
 * small `thumb` JPEG (lists, pickers and PDF lines never pull the big one).
 * It is its own company-scoped table rather than columns on inventory_items for
 * the same reason bill_payment_proofs is: stored_files carries no company_id,
 * and the row's own id is what the signed media URL is built from.
 *
 * inventory_items.image_id points at the item's CURRENT photo. One photo per
 * item today; a gallery later is more rows here, not another migration.
 *
 * No foreign key on image_id, deliberately: environments running with
 * DB_SYNCHRONIZE=true drop constraints the entities do not declare, and the
 * service keeps the pointer and the row in step inside one transaction.
 */
export class InventoryItemImages1790200000000 implements MigrationInterface {
  name = 'InventoryItemImages1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_item_images" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "item_id" uuid NOT NULL,
        "storage_key" character varying(255) NOT NULL,
        "thumb_storage_key" character varying(255) NOT NULL,
        "mime_type" character varying(64) NOT NULL DEFAULT 'image/jpeg',
        "width" integer NOT NULL,
        "height" integer NOT NULL,
        "size" integer NOT NULL,
        "thumb_size" integer NOT NULL,
        "original_name" character varying(255) NOT NULL,
        "uploaded_by" uuid NOT NULL,
        CONSTRAINT "PK_inventory_item_images" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inventory_item_images_company_id"
        ON "inventory_item_images" ("company_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inventory_item_images_company_item"
        ON "inventory_item_images" ("company_id", "item_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "inventory_items"
        ADD COLUMN IF NOT EXISTS "image_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inventory_items" DROP COLUMN IF EXISTS "image_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_inventory_item_images_company_item"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_inventory_item_images_company_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_item_images"`);
  }
}
