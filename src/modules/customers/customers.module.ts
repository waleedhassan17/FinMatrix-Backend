import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './entities/customer.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Payment } from '../payments/entities/payment.entity';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { GeocodingService } from '../deliveries/geocoding.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, Invoice, Payment]), LedgerModule],
  controllers: [CustomersController],
  providers: [CustomersService, GeocodingService],
  exports: [CustomersService, TypeOrmModule],
})
export class CustomersModule {}
