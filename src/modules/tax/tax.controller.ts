import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { TaxService } from './tax.service';
import { CreateTaxRateDto, UpdateTaxRateDto, CreateTaxPaymentDto } from './dto/tax.dto';

@ApiTags('Tax')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('taxes')
export class TaxController {
  constructor(private readonly svc: TaxService) {}

  @Get('rates')
  @Roles('admin', 'staff')
  listRates(
    @CurrentCompany() companyId: string,
    @Query('isActive') isActive: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listRates(companyId, page, limit, isActive === 'true');
  }

  @Post('rates')
  @Roles('admin')
  createRate(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateTaxRateDto,
  ) {
    return this.svc.createRate(companyId, dto);
  }

  @Get('rates/:id')
  @Roles('admin', 'staff')
  getRate(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getRate(companyId, id);
  }

  @Patch('rates/:id')
  @Roles('admin')
  updateRate(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxRateDto,
  ) {
    return this.svc.updateRate(companyId, id, dto);
  }

  @Delete('rates/:id')
  @Roles('admin')
  deleteRate(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteRate(companyId, id);
  }

  @Get('payments')
  @Roles('admin', 'staff')
  listPayments(
    @CurrentCompany() companyId: string,
    @Query('taxRateId') taxRateId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listPayments(companyId, taxRateId, page, limit);
  }

  @Post('payments')
  @Roles('admin')
  createPayment(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateTaxPaymentDto,
  ) {
    return this.svc.createPayment(companyId, dto);
  }

  @Get('liability')
  @Roles('admin', 'staff')
  getLiability(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate: string,
  ) {
    return this.svc.getLiability(companyId, asOfDate);
  }
}
