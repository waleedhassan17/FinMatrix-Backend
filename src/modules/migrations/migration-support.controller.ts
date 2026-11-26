import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { AllowWhenLapsed } from '../../common/decorators/allow-when-lapsed.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { assertSuperAdmin } from '../../common/guards/super-admin.util';
import { supportEmail } from '../../config/launch.settings';
import { MailService } from '../mail/mail.service';
import { esc, layout } from '../mail/mail.layout';
import { MigrationAdminService } from './migration-admin.service';

class HelpRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

/**
 * "Ask for help" from a migration: emails FinMatrix support the batch
 * reference and where it stands — status, readiness, open issue counts by
 * code, check outcomes. Never a row of the customer's data, a file, or an
 * amount. Allowed while a trial has lapsed too: that is when help matters.
 */
@ApiTags('Migration Center — support')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Roles('admin')
@Controller('migrations')
export class MigrationHelpController {
  constructor(
    private readonly reads: MigrationAdminService,
    private readonly mail: MailService,
    private readonly audit: OperationalAuditService,
  ) {}

  @Post(':id/help-request')
  @AllowWhenLapsed()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Send this migration to FinMatrix support.' })
  async help(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HelpRequestDto,
  ) {
    const batch = await this.reads.detail(id);
    if (batch.companyId !== companyId) {
      throw new NotFoundException('Migration not found');
    }
    const to = supportEmail();
    const issues = batch.issuesByCode
      .filter((i) => i.open > 0)
      .map((i) => `${i.code} (${i.severity}): ${i.open} open`);
    const checks = batch.checks.map(
      (c: { code: string; passed: boolean }) =>
        `${c.code}: ${c.passed ? 'passed' : 'FAILED'}`,
    );
    const note = (dto?.message ?? '').trim();
    const text =
      `Migration help request ${batch.reference}\n\n` +
      `Company: ${batch.companyName}\nFrom: ${user.email ?? user.username ?? user.id}\n` +
      `Source: ${batch.sourceSystem} · Status: ${batch.status} · Readiness: ${batch.readiness}%\n` +
      `Open issues:\n${issues.length ? issues.join('\n') : 'none'}\n` +
      `Checks:\n${checks.length ? checks.join('\n') : 'not run yet'}\n` +
      (note ? `\nMessage from the owner:\n${note}\n` : '') +
      `\nOpen it read-only in the admin console: Migrations → ${batch.reference}.`;
    if (to) {
      await this.mail.sendRendered(to, {
        subject: `Migration help: ${batch.reference} — ${batch.companyName ?? ''}`,
        html: layout(
          `Migration help request ${batch.reference}`,
          `<pre style="white-space:pre-wrap;font-family:inherit;">${esc(text)}</pre>`,
        ),
        text,
      });
    }
    await this.audit.record({
      companyId,
      actorUserId: user.id,
      action: 'migration_help_requested',
      targetType: 'migration_batch',
      targetId: id,
      details: { reference: batch.reference, hasMessage: !!note },
    });
    return { sent: !!to, reference: batch.reference };
  }
}

/** Super-admins: the read-only Migration Center view. */
@ApiTags('Admin — migrations')
@ApiBearerAuth()
@Controller('admin/migrations')
export class AdminMigrationsController {
  constructor(private readonly reads: MigrationAdminService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('stuck') stuck?: string,
    @Query('q') q?: string,
  ) {
    assertSuperAdmin(user);
    return this.reads.list({
      companyId,
      status,
      stuck: stuck === 'true',
      q,
      page,
      limit,
    });
  }

  @Get('counts')
  counts(@CurrentUser() user: AuthenticatedUser) {
    assertSuperAdmin(user);
    return this.reads.counts();
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.reads.detail(id);
  }
}
