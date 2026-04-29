import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Delete } from '@nestjs/common';
import { BillsService } from './bills.service';
import {
  CreateBillDto,
  ListBillsQueryDto,
  PayBillsDto,
  UpdateBillDto,
} from './dto/bill.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('bills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('bills')
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListBillsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.bills.list(companyId, query, pagination);
  }

  @Get(':billId')
  get(
    @CurrentCompany() companyId: string,
    @Param('billId', ParseUUIDPipe) billId: string,
  ) {
    return this.bills.getById(companyId, billId);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBillDto,
  ) {
    return this.bills.create(companyId, user.id, dto);
  }

  @Patch(':billId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('billId', ParseUUIDPipe) billId: string,
    @Body() dto: UpdateBillDto,
  ) {
    return this.bills.update(companyId, billId, dto);
  }

  @Post('pay')
  @Roles('admin')
  @HttpCode(200)
  pay(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayBillsDto,
  ) {
    return this.bills.pay(companyId, user.id, dto);
  }

  @Delete(':billId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('billId', ParseUUIDPipe) billId: string,
  ) {
    return this.bills.delete(companyId, billId);
  }
}
