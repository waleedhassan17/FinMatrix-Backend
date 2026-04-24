import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { BankingService } from './banking.service';
import { CreateBankAccountDto, UpdateBankAccountDto, CreateBankTransactionDto, ReconcileDto, BankAccountQueryDto } from './dto/banking.dto';

@ApiTags('Banking')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('banking')
export class BankingController {
  constructor(private readonly svc: BankingService) {}

  @Get('accounts')
  @Roles('admin', 'staff')
  listAccounts(
    @CurrentCompany() companyId: string,
    @Query() query: BankAccountQueryDto,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listAccounts(companyId, query, page, limit);
  }

  @Post('accounts')
  @Roles('admin')
  createAccount(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.svc.createAccount(companyId, dto);
  }

  @Get('accounts/:id')
  @Roles('admin', 'staff')
  getAccount(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getAccount(companyId, id);
  }

  @Patch('accounts/:id')
  @Roles('admin')
  updateAccount(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.svc.updateAccount(companyId, id, dto);
  }

  @Delete('accounts/:id')
  @Roles('admin')
  deleteAccount(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteAccount(companyId, id);
  }

  @Get('accounts/:id/transactions')
  @Roles('admin', 'staff')
  listTransactions(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listTransactions(companyId, id, page, limit);
  }

  @Post('transactions')
  @Roles('admin', 'staff')
  createTransaction(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateBankTransactionDto,
  ) {
    return this.svc.createTransaction(companyId, dto, 'user-id');
  }

  @Post('accounts/:id/reconcile')
  @Roles('admin', 'staff')
  reconcile(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconcileDto,
  ) {
    return this.svc.reconcile(companyId, id, dto, 'user-id');
  }

  @Get('accounts/:id/reconciliations')
  @Roles('admin', 'staff')
  listReconciliations(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listReconciliations(companyId, id, page, limit);
  }
}
