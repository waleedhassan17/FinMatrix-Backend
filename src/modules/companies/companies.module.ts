import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from './entities/company.entity';
import { UserCompany } from './entities/user-company.entity';
import { Account } from '../accounts/entities/account.entity';
import { UsersModule } from '../users/users.module';
import { CompaniesService } from './companies.service';
import { CompaniesController } from './companies.controller';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([Company, UserCompany, Account]),
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService, TypeOrmModule],
})
export class CompaniesModule {}
