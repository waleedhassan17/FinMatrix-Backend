import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * First Update (v1.0) scope: the in-app notification centre endpoints (list +
 * unread counts) are deferred to the Second Update, so the controller is
 * removed. NotificationsService stays because kept modules (deliveries,
 * inventory-approvals) emit notifications internally; riders still see delivery
 * status through the delivery endpoints.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
