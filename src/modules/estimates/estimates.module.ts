import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Estimate } from './entities/estimate.entity';
import { EstimateLineItem } from './entities/estimate-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';
import { InvoicesModule } from '../invoices/invoices.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Estimate, EstimateLineItem, Customer]),
    InvoicesModule,
    SalesOrdersModule,
  ],
  controllers: [EstimatesController],
  providers: [EstimatesService],
  exports: [EstimatesService, TypeOrmModule],
})
export class EstimatesModule {}
