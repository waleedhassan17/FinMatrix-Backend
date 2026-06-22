import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesOrder } from './entities/sales-order.entity';
import { SalesOrderLineItem } from './entities/sales-order-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { SalesOrdersService } from './sales-orders.service';
import { SalesOrdersController } from './sales-orders.controller';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SalesOrder, SalesOrderLineItem, Customer]),
    InvoicesModule,
  ],
  controllers: [SalesOrdersController],
  providers: [SalesOrdersService],
  exports: [SalesOrdersService, TypeOrmModule],
})
export class SalesOrdersModule {}
