import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyMessagingSettings } from './entities/company-messaging-settings.entity';
import { OutboundMessage } from './entities/outbound-message.entity';
import { MessageStatusEvent } from './entities/message-status-event.entity';
import { MessagingUsage } from './entities/messaging-usage.entity';
import { MessagingService } from './messaging.service';
import { MessagingSettingsService } from './messaging-settings.service';
import { DocumentRendererRegistry } from './document-renderer.registry';

/**
 * The half of FinMatrix Connect that domain modules can safely import
 * (the same split as ApprovalsCoreModule).
 *
 * Invoices, bills, payments, purchase orders, approvals and deliveries each
 * call MessagingService.enqueue() after a posting succeeds; their PDF services
 * register with DocumentRendererRegistry. Neither needs a domain service, so
 * this module imports none — which is what lets MessagingModule (dispatcher,
 * webhook, crons, API) depend on domain modules without a cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CompanyMessagingSettings,
      OutboundMessage,
      MessageStatusEvent,
      MessagingUsage,
    ]),
  ],
  providers: [
    MessagingService,
    MessagingSettingsService,
    DocumentRendererRegistry,
  ],
  exports: [
    MessagingService,
    MessagingSettingsService,
    DocumentRendererRegistry,
    TypeOrmModule,
  ],
})
export class MessagingCoreModule {}
