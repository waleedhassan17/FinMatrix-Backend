import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from './entities/employee.entity';
import { PayrollRun } from './entities/payroll-run.entity';
import { PayrollItem } from './entities/payroll-item.entity';
import { PayrollService } from './payroll.service';
import { PayrollController } from './payroll.controller';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, PayrollRun, PayrollItem]),
    JournalEntriesModule,
    AccountsModule,
  ],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService, TypeOrmModule],
})
export class PayrollModule {}
