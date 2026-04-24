import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { VendorCreditsService } from './vendor-credits.service';
import {
  ApplyVendorCreditDto,
  CreateVendorCreditDto,
} from './dto/vendor-credit.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('vendor-credits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('vendor-credits')
export class VendorCreditsController {
  constructor(private readonly service: VendorCreditsService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.service.list(companyId, pagination);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorCreditDto,
  ) {
    return this.service.create(companyId, user.id, dto);
  }

  @Post(':creditId/apply')
  @Roles('admin')
  apply(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
    @Body() dto: ApplyVendorCreditDto,
  ) {
    return this.service.apply(companyId, creditId, dto);
  }
}
