import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Estimate } from './entities/estimate.entity';
import { EstimateLineItem } from './entities/estimate-line-item.entity';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [TypeOrmModule.forFeature([Estimate, EstimateLineItem]), InvoicesModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
})
export class EstimatesModule {}
