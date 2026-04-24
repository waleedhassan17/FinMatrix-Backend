import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeneralLedgerEntry } from './entities/general-ledger.entity';
import { LedgerService } from './ledger.service';
import { LedgerController } from './ledger.controller';

@Module({
  imports: [TypeOrmModule.forFeature([GeneralLedgerEntry])],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService, TypeOrmModule],
})
export class LedgerModule {}
