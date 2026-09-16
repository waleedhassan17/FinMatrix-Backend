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
  ConvertEstimateDto, ConvertEstimateToSalesOrderDto, CreateEstimateDto, EstimateStatusDto, ListEstimatesQueryDto, UpdateEstimateDto,
} from './dto/estimate.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { creditOverrideFrom } from '../../common/validation/credit-override.dto';

@ApiTags('estimates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('estimates') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('estimates')
export class EstimatesController {
  constructor(
    private readonly estimates: EstimatesService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

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
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEstimateDto,
  ) {
    return this.estimates.create(companyId, user.id, dto);
  }

  @Patch(':estimateId')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEstimateDto,
  ) {
    return this.estimates.update(companyId, id, dto);
  }

  @Patch(':estimateId/status')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Update estimate status (sent / accepted / declined).' })
  setStatus(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: EstimateStatusDto,
  ) {
    return this.estimates.setStatus(companyId, id, dto);
  }

  @Post(':estimateId/convert-to-invoice')
  @Roles('admin', 'staff')
  @HttpCode(201)
  @ApiOperation({ summary: 'Convert an accepted estimate into an invoice.' })
  async convertToInvoice(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: ConvertEstimateDto,
  ) {
    if (user.role === 'admin') {
      return this.estimates.convertToInvoice(companyId, user.id, id, dto, creditOverrideFrom(dto.creditOverride, user));
    }
    // Converting posts an invoice; staff invoices go to the owner.
    const { estimateNumber, payload } = await this.estimates.conversionPayload(companyId, id, dto);
    return this.approvals.createRequest(
      'invoice',
      payload as unknown as Record<string, unknown>,
      `Invoice from estimate ${estimateNumber}: ${payload.lines.length} line(s), due ${payload.dueDate}`,
      user,
      companyId,
    );
  }

  @Post(':estimateId/convert-to-sales-order')
  @Roles('admin', 'staff')
  @HttpCode(201)
  @ApiOperation({ summary: 'Convert an accepted estimate into a sales order.' })
  convertToSalesOrder(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('estimateId', ParseUUIDPipe) id: string,
    @Body() dto: ConvertEstimateToSalesOrderDto,
  ) {
    return this.estimates.convertToSalesOrder(companyId, user.id, id, dto ?? {});
  }

  @Delete(':estimateId')
  @Roles('admin')
  remove(@CurrentCompany() companyId: string, @Param('estimateId', ParseUUIDPipe) id: string) {
    return this.estimates.delete(companyId, id);
  }
}
