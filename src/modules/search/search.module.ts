import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { Customer } from '../customers/entities/customer.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, Vendor, Invoice, Bill, InventoryItem])],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
