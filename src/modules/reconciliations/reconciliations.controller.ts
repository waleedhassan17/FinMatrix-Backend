import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ReconciliationsService } from './reconciliations.service';
import {
  CreateReconciliationDto,
  ListReconciliationsQueryDto,
  UnreconciledQueryDto,
} from './dto/reconciliation.dto';

@ApiTags('Bank Reconciliation')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('reconciliations')
export class ReconciliationsController {
  constructor(private readonly svc: ReconciliationsService) {}

  // Static routes are declared before `:id` so they are matched first.
  @Get('accounts')
  @Roles('admin', 'staff')
  listAccounts(@CurrentCompany() companyId: string) {
    return this.svc.listAccounts(companyId);
  }

  @Get('unreconciled')
  @Roles('admin', 'staff')
  getUnreconciled(
    @CurrentCompany() companyId: string,
    @Query() query: UnreconciledQueryDto,
  ) {
    return this.svc.getUnreconciled(companyId, query);
  }

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListReconciliationsQueryDto,
  ) {
    return this.svc.list(companyId, query);
  }

  @Get(':id')
  @Roles('admin', 'staff')
  getById(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getById(companyId, id);
  }

  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReconciliationDto,
  ) {
    return this.svc.create(companyId, user.id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.remove(companyId, id);
  }
}
