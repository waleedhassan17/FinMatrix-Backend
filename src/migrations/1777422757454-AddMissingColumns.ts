import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMissingColumns1777422757454 implements MigrationInterface {
    name = 'AddMissingColumns1777422757454'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inventory_approval_audit_entries" DROP CONSTRAINT "FK_inv_audit_request"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_inv_req_delivery"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_inv_audit_request_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_inv_audit_company_created"`);
        await queryRunner.query(`ALTER TABLE "credit_memos" ADD "status" character varying(20) NOT NULL DEFAULT 'open'`);
        await queryRunner.query(`ALTER TABLE "agencies" ADD "isActive" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "delivery_personnel_profiles" ALTER COLUMN "zones" SET DEFAULT '[]'::jsonb`);
        await queryRunner.query(`ALTER TABLE "delivery_issues" ALTER COLUMN "photos" SET DEFAULT '[]'::jsonb`);
        await queryRunner.query(`CREATE INDEX "IDX_ece05598d9c030dff972e62e14" ON "inventory_approval_audit_entries" ("company_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fc6015a247767505c7e7636e9" ON "inventory_approval_audit_entries" ("request_id", "created_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_0fc6015a247767505c7e7636e9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ece05598d9c030dff972e62e14"`);
        await queryRunner.query(`ALTER TABLE "delivery_issues" ALTER COLUMN "photos" SET DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "delivery_personnel_profiles" ALTER COLUMN "zones" SET DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "agencies" DROP COLUMN "isActive"`);
        await queryRunner.query(`ALTER TABLE "credit_memos" DROP COLUMN "status"`);
        await queryRunner.query(`CREATE INDEX "IDX_inv_audit_company_created" ON "inventory_approval_audit_entries" ("company_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_inv_audit_request_created" ON "inventory_approval_audit_entries" ("request_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_inv_req_delivery" ON "inventory_update_requests" ("delivery_id") `);
        await queryRunner.query(`ALTER TABLE "inventory_approval_audit_entries" ADD CONSTRAINT "FK_inv_audit_request" FOREIGN KEY ("request_id") REFERENCES "inventory_update_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
