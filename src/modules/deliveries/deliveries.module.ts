import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';
import { DeliveryItem } from './entities/delivery-item.entity';
import { DeliveryStatusHistory } from './entities/delivery-status-history.entity';
import { DeliverySignature } from './entities/delivery-signature.entity';
import { DeliveryIssue } from './entities/delivery-issue.entity';
import { DeliveryLocationLog } from './entities/delivery-location-log.entity';
import { DeliveryPersonnelProfile } from '../delivery-personnel/entities/delivery-personnel-profile.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesController } from './deliveries.controller';

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
    ]),
  ],
  providers: [DeliveriesService],
  controllers: [DeliveriesController],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
