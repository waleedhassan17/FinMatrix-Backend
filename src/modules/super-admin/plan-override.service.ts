import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  PLAN_CONFIG,
  isPlanKey,
  loadPlanOverrides,
  type PlanKey,
  type PlanOverridePatch,
} from '../billing/plan-config';
import { PlanOverride } from './entities/plan-override.entity';

/**
 * Owns the admin's edits to the plan catalogue.
 *
 * The catalogue itself stays in code. This service holds the layer on top and
 * is the ONLY writer of plan-config's override map: it loads the table at
 * boot and re-loads after every write, so the synchronous getPlanConfig() that
 * billing, auth, companies and delivery-personnel already call picks up an
 * edit without any of them changing.
 *
 * If this table is unreadable the console loses the ability to edit prices,
 * and nothing else changes -- every plan resolves from config, which is what
 * shipped before any of this existed. That is the intended failure mode, and
 * it is why refresh() logs rather than throws.
 */
@Injectable()
export class PlanOverrideService implements OnModuleInit {
  private readonly logger = new Logger(PlanOverrideService.name);

  constructor(
    @InjectRepository(PlanOverride)
    private readonly repo: Repository<PlanOverride>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Reload the whole set into plan-config's map. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.repo.find();
      loadPlanOverrides(
        rows
          .filter((r) => isPlanKey(r.planKey))
          .map((r) => [r.planKey as PlanKey, toPatch(r)] as [PlanKey, PlanOverridePatch]),
      );
      this.logger.log(`Plan overrides loaded: ${rows.length}`);
    } catch (e) {
      // Boot must not depend on this table. Before the migration runs it does
      // not exist, and a console that cannot edit prices is a far better
      // outcome than an API that will not start.
      this.logger.warn(
        `Plan overrides not loaded, using config as-is: ${(e as Error).message}`,
      );
    }
  }

  /** Every plan key the admin may edit, with its current override if any. */
  async list(): Promise<PlanOverride[]> {
    return this.repo.find();
  }

  /**
   * Apply an edit.
   *
   * Prices are validated against the plan's duration rather than taken on
   * trust: priceMinorUnits is what a customer is actually charged up front,
   * and monthlyMinorUnits is what they are quoted per month. Letting those
   * two disagree would show one number and bill another.
   */
  async apply(
    rawKey: string,
    patch: PlanOverridePatch,
    updatedBy: string | null,
  ): Promise<PlanOverride> {
    if (!isPlanKey(rawKey)) {
      throw new BadRequestException({
        code: 'UNKNOWN_PLAN',
        message: `No plan named "${rawKey}".`,
      });
    }
    const key = rawKey as PlanKey;
    const base = PLAN_CONFIG[key];

    if (patch.monthlyMinorUnits !== undefined && patch.monthlyMinorUnits < 0) {
      throw new BadRequestException({
        code: 'INVALID_PRICE',
        message: 'A monthly price cannot be negative.',
      });
    }
    if (patch.priceMinorUnits !== undefined && patch.priceMinorUnits < 0) {
      throw new BadRequestException({
        code: 'INVALID_PRICE',
        message: 'A total price cannot be negative.',
      });
    }
    if (
      patch.deliveryPersonnelLimit !== undefined &&
      patch.deliveryPersonnelLimit < 0
    ) {
      throw new BadRequestException({
        code: 'INVALID_LIMIT',
        message: 'A rider limit cannot be negative.',
      });
    }

    const existing = await this.repo.findOne({ where: { planKey: key } });
    const merged: PlanOverridePatch = { ...toPatch(existing), ...patch };

    // The config's own invariant: the total is the monthly rate for the whole
    // period. Enforced on the merged result, so editing one field cannot
    // silently break its relationship with the other.
    const months = base.durationMonths;
    if (months && months > 0) {
      const monthly = merged.monthlyMinorUnits ?? base.monthlyMinorUnits;
      const total = merged.priceMinorUnits ?? base.priceMinorUnits;
      if (monthly * months !== total) {
        throw new BadRequestException({
          code: 'PRICE_MISMATCH',
          message:
            `The total must equal the monthly price times ${months} months. ` +
            `Monthly ${monthly / 100} over ${months} months is ` +
            `${(monthly * months) / 100}, not ${total / 100}.`,
        });
      }
    }

    const row = this.repo.create({
      planKey: key,
      label: merged.label ?? null,
      monthlyMinorUnits: merged.monthlyMinorUnits ?? null,
      priceMinorUnits: merged.priceMinorUnits ?? null,
      deliveryPersonnelLimit: merged.deliveryPersonnelLimit ?? null,
      isOffered: merged.isOffered ?? null,
      updatedBy,
    });
    const saved = await this.repo.save(row);

    // Price changes are the one thing here worth being able to reconstruct
    // from logs, since the table keeps only the current value.
    this.logger.log(
      `Plan ${key} edited by ${updatedBy ?? 'unknown'}: ${JSON.stringify(patch)}`,
    );
    await this.refresh();
    return saved;
  }

  /** Drop the override, returning the plan to exactly what the config says. */
  async reset(rawKey: string): Promise<void> {
    if (!isPlanKey(rawKey)) {
      throw new BadRequestException({
        code: 'UNKNOWN_PLAN',
        message: `No plan named "${rawKey}".`,
      });
    }
    await this.repo.delete({ planKey: rawKey });
    this.logger.log(`Plan ${rawKey} reset to configuration`);
    await this.refresh();
  }
}

function toPatch(row: PlanOverride | null | undefined): PlanOverridePatch {
  if (!row) return {};
  const patch: PlanOverridePatch = {};
  if (row.label !== null) patch.label = row.label;
  if (row.monthlyMinorUnits !== null) patch.monthlyMinorUnits = row.monthlyMinorUnits;
  if (row.priceMinorUnits !== null) patch.priceMinorUnits = row.priceMinorUnits;
  if (row.deliveryPersonnelLimit !== null) {
    patch.deliveryPersonnelLimit = row.deliveryPersonnelLimit;
  }
  if (row.isOffered !== null) patch.isOffered = row.isOffered;
  return patch;
}
