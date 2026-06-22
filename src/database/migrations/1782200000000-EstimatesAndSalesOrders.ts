import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase A — Sales pipeline: Estimates/Quotes and Sales Orders, each with line
 * items. Both are non-posting documents until converted into an Invoice (or an
 * Estimate into a Sales Order), so they carry no journal_entry_id.
 */
export class EstimatesAndSalesOrders1782200000000 implements MigrationInterface {
  name = 'EstimatesAndSalesOrders1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "estimates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "customer_id" uuid NOT NULL,
        "estimate_number" character varying(32) NOT NULL,
        "estimate_date" date NOT NULL,
        "expiry_date" date,
        "subtotal" numeric(18,4) NOT NULL DEFAULT 0,
        "discount_type" character varying(8) NOT NULL DEFAULT 'none',
        "discount_value" numeric(18,4) NOT NULL DEFAULT 0,
        "discount_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "tax_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "total" numeric(18,4) NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'draft',
        "notes" text,
        "converted_to_type" character varying(16),
        "converted_to_id" uuid,
        "created_by" uuid NOT NULL,
        CONSTRAINT "PK_estimates" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_estimates_company_number" ON "estimates" ("company_id","estimate_number")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_estimates_company_status" ON "estimates" ("company_id","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_estimates_company_customer" ON "estimates" ("company_id","customer_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "estimate_line_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "estimate_id" uuid NOT NULL,
        "description" text NOT NULL,
        "quantity" numeric(18,4) NOT NULL DEFAULT 1,
        "unit_price" numeric(18,4) NOT NULL DEFAULT 0,
        "tax_rate" numeric(8,4) NOT NULL DEFAULT 0,
        "tax_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "line_total" numeric(18,4) NOT NULL DEFAULT 0,
        "account_id" uuid,
        "line_order" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_estimate_line_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_estimate_line_items_estimate" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_estimate_line_items_estimate" ON "estimate_line_items" ("estimate_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "customer_id" uuid NOT NULL,
        "order_number" character varying(32) NOT NULL,
        "order_date" date NOT NULL,
        "expected_date" date,
        "subtotal" numeric(18,4) NOT NULL DEFAULT 0,
        "discount_type" character varying(8) NOT NULL DEFAULT 'none',
        "discount_value" numeric(18,4) NOT NULL DEFAULT 0,
        "discount_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "tax_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "total" numeric(18,4) NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'open',
        "notes" text,
        "source_estimate_id" uuid,
        "invoice_id" uuid,
        "created_by" uuid NOT NULL,
        CONSTRAINT "PK_sales_orders" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sales_orders_company_number" ON "sales_orders" ("company_id","order_number")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sales_orders_company_status" ON "sales_orders" ("company_id","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sales_orders_company_customer" ON "sales_orders" ("company_id","customer_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_order_line_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sales_order_id" uuid NOT NULL,
        "description" text NOT NULL,
        "quantity" numeric(18,4) NOT NULL DEFAULT 1,
        "quantity_fulfilled" numeric(18,4) NOT NULL DEFAULT 0,
        "unit_price" numeric(18,4) NOT NULL DEFAULT 0,
        "tax_rate" numeric(8,4) NOT NULL DEFAULT 0,
        "tax_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "line_total" numeric(18,4) NOT NULL DEFAULT 0,
        "account_id" uuid,
        "line_order" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_sales_order_line_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sales_order_line_items_order" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sales_order_line_items_order" ON "sales_order_line_items" ("sales_order_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_order_line_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "estimate_line_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "estimates"`);
  }
}
