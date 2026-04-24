import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryPersonnelProfile } from './entities/delivery-personnel-profile.entity';
import { DeliveryPersonnelService } from './delivery-personnel.service';
import { DeliveryPersonnelController } from './delivery-personnel.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DeliveryPersonnelProfile])],
  providers: [DeliveryPersonnelService],
  controllers: [DeliveryPersonnelController],
  exports: [DeliveryPersonnelService],
})
export class DeliveryPersonnelModule {}
