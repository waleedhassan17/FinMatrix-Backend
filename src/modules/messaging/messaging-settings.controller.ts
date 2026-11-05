import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { MessagingSettingsService } from './messaging-settings.service';
import { MessagesService } from './messages.service';
import { UpdateMessagingSettingsDto } from './dto/messaging.dto';

/**
 * FinMatrix Connect settings. Staff may read them (the app and web decide
 * what to offer from them); only an owner changes them, and every change is
 * on the audit trail. The access token is write-only.
 */
@ApiTags('messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('whatsappConnect')
@Roles('admin', 'staff')
@Controller('settings/messaging')
export class MessagingSettingsController {
  constructor(
    private readonly settings: MessagingSettingsService,
    private readonly messages: MessagesService,
    private readonly audit: OperationalAuditService,
  ) {}

  @Get()
  async get(@CurrentCompany() companyId: string) {
    return this.settings.view(await this.settings.resolve(companyId));
  }

  @Put()
  @Roles('admin')
  @ApiOperation({
    summary: 'Update Connect settings (owner). The token is stored encrypted.',
  })
  async update(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMessagingSettingsDto,
  ) {
    const before = await this.settings.resolve(companyId);
    const after = await this.settings.update(companyId, dto);
    const changed = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );
    await this.audit.record({
      companyId,
      actorUserId: user.id,
      action: 'messaging_settings_updated',
      targetType: 'company_messaging_settings',
      targetId: companyId,
      details: {
        changed,
        enabled: { from: before.enabled, to: after.enabled },
        // Never the token itself: only that it was set or cleared.
        accessToken:
          dto.accessToken === undefined
            ? undefined
            : dto.accessToken
              ? 'set'
              : 'cleared',
      },
    });
    return this.settings.view(after);
  }

  @Post('test')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({
    summary: "Send fm_test to the caller's own WhatsApp number.",
  })
  async test(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.messages.sendTest(companyId, user.id);
  }

  @Post('confirm-contacts-consent')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Owner confirms existing contacts agreed to WhatsApp messages (once).',
  })
  async confirmConsent(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const before = await this.settings.resolve(companyId);
    const after = await this.settings.confirmContactsConsent(
      companyId,
      user.id,
    );
    if (!before.contactsOptInConfirmedAt) {
      await this.audit.record({
        companyId,
        actorUserId: user.id,
        action: 'messaging_contacts_consent_confirmed',
        targetType: 'company_messaging_settings',
        targetId: companyId,
        details: { confirmedAt: after.contactsOptInConfirmedAt },
      });
    }
    return {
      ...this.settings.view(after),
      alreadyConfirmed: Boolean(before.contactsOptInConfirmedAt),
    };
  }
}
