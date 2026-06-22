import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { VendorCreditsService } from './vendor-credits.service';
import { ApplyVendorCreditDto, CreateVendorCreditDto, ListVendorCreditsQueryDto } from './dto/vendor-credit.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';

@ApiTags('vendor-credits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('vendor-credits')
export class VendorCreditsController {
  constructor(private readonly svc: VendorCreditsService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListVendorCreditsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.svc.list(companyId, query, pagination);
  }

  @Get(':id')
  get(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getById(companyId, id);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorCreditDto,
  ) {
    return this.svc.create(companyId, user.id, dto);
  }

  @Post(':id/apply')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply available vendor credit to an open bill.' })
  apply(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyVendorCreditDto,
  ) {
    return this.svc.applyToBill(companyId, id, dto);
  }

  @Post(':id/void')
  @Roles('admin')
  @HttpCode(200)
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.void(companyId, id, user.id);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.delete(companyId, id);
  }
}
