import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * An admin's edit to one plan from PLAN_CONFIG.
 *
 * Plans are DEFINED in code (billing/plan-config.ts) and that stays true --
 * this table does not replace the catalogue, it layers on top of it. A plan
 * with no row here resolves exactly as the config declares it, which means
 * the fallback for anything going wrong with this table is the behaviour that
 * shipped.
 *
 * The primary key is the plan KEY ('warehouse_starter_6mo'), not a UUID,
 * because that key is what every company row already stores and what the
 * config is indexed by. There is deliberately no second id.
 *
 * Every column is nullable: null means "no opinion, use the config". That is
 * what makes a partial edit possible and what makes reverting one field a
 * matter of writing null rather than knowing the original value.
 */
@Entity('plan_overrides')
export class PlanOverride {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  planKey!: string;

  /** Display name. Does not affect pricing or limits. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  label!: string | null;

  /** Per-month price in MINOR UNITS (paisa). */
  @Column({ type: 'int', nullable: true })
  monthlyMinorUnits!: number | null;

  /** TOTAL charged up front for the whole duration, in minor units. */
  @Column({ type: 'int', nullable: true })
  priceMinorUnits!: number | null;

  /** Max simultaneously-active riders. The only plan limit enforced anywhere. */
  @Column({ type: 'int', nullable: true })
  deliveryPersonnelLimit!: number | null;

  /**
   * false retires the plan: companies already on it keep resolving, renewing
   * and being charged correctly, but it is offered to nobody new. This is the
   * honest replacement for deleting a plan, which was never safe -- a deleted
   * plan leaves existing subscriptions pointing at nothing.
   */
  @Column({ type: 'boolean', nullable: true })
  isOffered!: boolean | null;

  /** Who made the change, for the audit trail the platform otherwise lacks. */
  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
