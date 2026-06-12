import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';
import { DeliveryItem } from './entities/delivery-item.entity';
import { DeliveryStatusHistory } from './entities/delivery-status-history.entity';
import { DeliverySignature } from './entities/delivery-signature.entity';
import { DeliveryIssue } from './entities/delivery-issue.entity';
import { DeliveryLocationLog } from './entities/delivery-location-log.entity';
import { DeliveryPersonnelProfile } from '../delivery-personnel/entities/delivery-personnel-profile.entity';
import { Customer } from '../customers/entities/customer.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesController } from './deliveries.controller';
import { GeocodingService } from './geocoding.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Delivery,
      DeliveryItem,
      DeliveryStatusHistory,
      DeliverySignature,
      DeliveryIssue,
      DeliveryLocationLog,
      DeliveryPersonnelProfile,
      Customer,
    ]),
    NotificationsModule,
  ],
  providers: [DeliveriesService, GeocodingService],
  controllers: [DeliveriesController],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
