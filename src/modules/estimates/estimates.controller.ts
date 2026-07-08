import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { EstimatesService } from './estimates.service';
import {
  ConvertEstimateDto, CreateEstimateDto, EstimateStatusDto, ListEstimatesQueryDto, UpdateEstimateDto,
} from './dto/estimate.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('estimates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('estimates') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimates: EstimatesService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListEstimatesQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.estimates.list(companyId, query, pagination);
  }

  @Get(':estimateId')
  get(@CurrentCompany() companyId: string, @Param('estimateId', ParseUUIDPipe) id: string) {
    return this.estimates.getById(companyId, id);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEstimateDto,
  ) {
    return this.estimates.create(companyId, user.id, dto);
  }

  @Patch(':estimateId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEstimateDto,
  ) {
    return this.estimates.update(companyId, id, dto);
  }

  @Patch(':estimateId/status')
  @Roles('admin')
  @ApiOperation({ summary: 'Update estimate status (sent / accepted / declined).' })
  setStatus(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: EstimateStatusDto,
  ) {
    return this.estimates.setStatus(companyId, id, dto);
  }

  @Post(':estimateId/convert-to-invoice')
  @Roles('admin')
  @HttpCode(201)
  @ApiOperation({ summary: 'Convert an accepted estimate into an invoice.' })
  convertToInvoice(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: ConvertEstimateDto,
  ) {
    return this.estimates.convertToInvoice(companyId, user.id, id, dto);
  }

  @Post(':estimateId/convert-to-sales-order')
  @Roles('admin')
  @HttpCode(201)
  @ApiOperation({ summary: 'Convert an accepted estimate into a sales order.' })
  convertToSalesOrder(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('estimateId', ParseUUIDPipe) id: string,
  ) {
    return this.estimates.convertToSalesOrder(companyId, user.id, id);
  }

  @Delete(':estimateId')
  @Roles('admin')
  remove(@CurrentCompany() companyId: string, @Param('estimateId', ParseUUIDPipe) id: string) {
    return this.estimates.delete(companyId, id);
  }
}
