import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Body for POST /companies/start-trial.
 *
 * There is deliberately NO plan field. Every trial is the same fixed trial
 * plan (billing/plan-config.ts `warehouse_trial`: all features, one delivery
 * rider, 30 days); the owner chooses a paid plan when they subscribe. Accepting
 * a plan here would invite a client to request a trial of something bigger.
 *
 * `companyId` is optional because the web client sends it as the
 * x-company-id header instead; a freshly signed-up owner's JWT carries none.
 */
export class StartTrialDto {
  @ApiPropertyOptional({ description: 'The company to request a trial for.' })
  @IsOptional()
  @IsUUID()
  companyId?: string;
}
