import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaxRate } from './entities/tax-rate.entity';
import { TaxPayment } from './entities/tax-payment.entity';
import { TaxService } from './tax.service';
import { TaxController } from './tax.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TaxRate, TaxPayment])],
  providers: [TaxService],
  controllers: [TaxController],
  exports: [TaxService],
})
export class TaxModule {}
