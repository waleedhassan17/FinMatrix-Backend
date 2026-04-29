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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { VendorsService } from './vendors.service';
import {
  CreateVendorDto,
  ListVendorsQueryDto,
  UpdateVendorDto,
} from './dto/vendor.dto';
import { Delete, HttpCode } from '@nestjs/common';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('vendors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListVendorsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.vendors.list(companyId, query, pagination);
  }

  @Get(':vendorId')
  get(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.getById(companyId, vendorId);
  }

  @Post()
  @Roles('admin')
  create(@CurrentCompany() companyId: string, @Body() dto: CreateVendorDto) {
    return this.vendors.create(companyId, dto);
  }

  @Patch(':vendorId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Body() dto: UpdateVendorDto,
  ) {
    return this.vendors.update(companyId, vendorId, dto);
  }

  @Get(':vendorId/bills')
  bills(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.bills(companyId, vendorId);
  }

  @Get(':vendorId/payments')
  payments(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.payments(companyId, vendorId);
  }

  @Delete(':vendorId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.delete(companyId, vendorId);
  }

  @Patch(':vendorId/toggle-active')
  @Roles('admin')
  @HttpCode(200)
  toggleActive(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.toggleActive(companyId, vendorId);
  }
}
