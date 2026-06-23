import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Budget } from './entities/budget.entity';
import { BudgetLine } from './entities/budget-line.entity';
import { Account } from '../accounts/entities/account.entity';
import { BudgetsService } from './budgets.service';
import { BudgetsController } from './budgets.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Budget, BudgetLine, Account])],
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService, TypeOrmModule],
})
export class BudgetsModule {}
