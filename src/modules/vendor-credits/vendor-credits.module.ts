import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VendorCredit } from './entities/vendor-credit.entity';
import { VendorCreditLine } from './entities/vendor-credit-line.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { VendorCreditsService } from './vendor-credits.service';
import { VendorCreditsController } from './vendor-credits.controller';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';
import { BillsModule } from '../bills/bills.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([VendorCredit, VendorCreditLine, Vendor]),
    JournalEntriesModule,
    AccountsModule,
    BillsModule,
  ],
  controllers: [VendorCreditsController],
  providers: [VendorCreditsService],
})
export class VendorCreditsModule {}
