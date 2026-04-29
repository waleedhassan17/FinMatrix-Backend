import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  StatementQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import { Delete, HttpCode } from '@nestjs/common';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'List customers with filters + summary.' })
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListCustomersQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.customers.list(companyId, query, pagination);
  }

  @Get(':customerId')
  @ApiOperation({ summary: 'Customer detail + recent activity + credit calc.' })
  detail(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.detail(companyId, customerId);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.create(companyId, dto);
  }

  @Patch(':customerId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(companyId, customerId, dto);
  }

  @Get(':customerId/invoices')
  invoices(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.invoices(companyId, customerId);
  }

  @Get(':customerId/payments')
  payments(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.payments(companyId, customerId);
  }

  @Get(':customerId/statement')
  @ApiOperation({ summary: 'Period statement: opening + activity + closing.' })
  statement(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.customers.statement(companyId, customerId, query);
  }

  @Delete(':customerId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.delete(companyId, customerId);
  }

  @Patch(':customerId/toggle-active')
  @Roles('admin')
  @HttpCode(200)
  toggleActive(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.toggleActive(companyId, customerId);
  }
}
