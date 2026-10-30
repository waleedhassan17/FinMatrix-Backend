import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { TaxPayment } from '../tax/entities/tax-payment.entity';
import { ReportsService } from './reports.service';
import { ReportsKpiService } from './reports-kpi.service';
import { BudgetsModule } from '../budgets/budgets.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReportsController } from './reports.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Invoice, Bill, InventoryItem, InventoryMovement, Delivery, TaxPayment]),
    BudgetsModule,
    // For MediaUrlSigner: the item explorer shows the item's photo.
    InventoryModule,
  ],
  // ReportsKpiService is the one place KPI formulas live; it reads the
  // statements through ReportsService, never the other way round.
  providers: [ReportsService, ReportsKpiService],
  controllers: [ReportsController],
  exports: [ReportsService, ReportsKpiService],
})
export class ReportsModule {}
