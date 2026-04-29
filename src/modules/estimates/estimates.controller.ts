import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  CreateEstimateDto,
  ListEstimatesQueryDto,
  UpdateEstimateDto,
} from './dto/estimate.dto';
import { EstimatesService } from './estimates.service';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('estimates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('estimates')
export class EstimatesController {
  constructor(private readonly service: EstimatesService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListEstimatesQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.service.list(companyId, query, pagination);
  }

  @Get(':estimateId')
  get(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) estimateId: string,
  ) {
    return this.service.getById(companyId, estimateId);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateEstimateDto,
  ) {
    return this.service.create(companyId, dto);
  }

  @Patch(':estimateId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) estimateId: string,
    @Body() dto: UpdateEstimateDto,
  ) {
    return this.service.update(companyId, estimateId, dto);
  }

  @Post(':estimateId/convert-to-invoice')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Convert estimate to sent invoice; status -> accepted.' })
  convert(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('estimateId', ParseUUIDPipe) estimateId: string,
  ) {
    return this.service.convertToInvoice(companyId, user.id, estimateId);
  }

  @Delete(':estimateId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) estimateId: string,
  ) {
    return this.service.delete(companyId, estimateId);
  }

  @Post(':estimateId/send')
  @Roles('admin')
  @HttpCode(200)
  send(
    @CurrentCompany() companyId: string,
    @Param('estimateId', ParseUUIDPipe) estimateId: string,
  ) {
    return this.service.send(companyId, estimateId);
  }
}
