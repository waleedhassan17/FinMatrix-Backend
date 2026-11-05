import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagingCoreModule } from './messaging-core.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MessageStatusService } from './message-status.service';
import { MessagingDispatcherService } from './messaging-dispatcher.service';
import { MetaCloudProvider } from './providers/meta-cloud.provider';
import { FakeWhatsAppProvider } from './providers/fake-whatsapp.provider';
import { WHATSAPP_PROVIDER } from './providers/whatsapp-provider';
import { WhatsAppWebhookController } from './webhook/whatsapp-webhook.controller';
import { whatsappLive } from './messaging-env.util';

/**
 * FinMatrix Connect: dispatcher, providers, webhook, collections crons and the
 * API. Imported only by AppModule; domain modules import MessagingCoreModule.
 */
@Module({
  imports: [MessagingCoreModule, NotificationsModule],
  controllers: [WhatsAppWebhookController],
  providers: [
    MessageStatusService,
    MetaCloudProvider,
    FakeWhatsAppProvider,
    {
      provide: WHATSAPP_PROVIDER,
      inject: [ConfigService, MetaCloudProvider, FakeWhatsAppProvider],
      useFactory: (
        config: ConfigService,
        meta: MetaCloudProvider,
        fake: FakeWhatsAppProvider,
      ) => (whatsappLive(config) ? meta : fake),
    },
    MessagingDispatcherService,
  ],
  exports: [MessageStatusService, MessagingDispatcherService],
})
export class MessagingModule {}
