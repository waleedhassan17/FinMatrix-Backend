import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryPersonnelProfile } from './entities/delivery-personnel-profile.entity';
import { DeliveryPersonnelService } from './delivery-personnel.service';
import { DeliveryPersonnelController } from './delivery-personnel.controller';
import { UsersModule } from '../users/users.module';

@Module({
  // UsersModule for CredentialVaultService: the creator of a rider account is
  // the custodian of its password, and the vault is where that copy lives.
  imports: [TypeOrmModule.forFeature([DeliveryPersonnelProfile]), UsersModule],
  providers: [DeliveryPersonnelService],
  controllers: [DeliveryPersonnelController],
  exports: [DeliveryPersonnelService],
})
export class DeliveryPersonnelModule {}
