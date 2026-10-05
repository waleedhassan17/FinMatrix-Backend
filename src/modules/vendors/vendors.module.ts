import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Vendor } from './entities/vendor.entity';
import { Bill } from '../bills/entities/bill.entity';
import { BillPayment } from '../bills/entities/bill-payment.entity';
import { VendorsService } from './vendors.service';
import { VendorsController } from './vendors.controller';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vendor, Bill, BillPayment]), LedgerModule],
  controllers: [VendorsController],
  providers: [VendorsService],
  exports: [VendorsService, TypeOrmModule],
})
export class VendorsModule {}
