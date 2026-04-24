import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { UseGuards } from '@nestjs/common';
import { AgenciesService } from './agencies.service';
import { CreateAgencyDto, UpdateAgencyDto, AgencyQueryDto } from './dto/agency.dto';

@ApiTags('Agencies')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('agencies')
export class AgenciesController {
  constructor(private readonly svc: AgenciesService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query() query: AgencyQueryDto,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, query, page, limit);
  }

  @Get(':id')
  @Roles('admin', 'staff')
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getById(companyId, id);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateAgencyDto,
  ) {
    return this.svc.create(companyId, dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgencyDto,
  ) {
    return this.svc.update(companyId, id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.remove(companyId, id);
  }

  @Patch(':id/connected')
  @Roles('admin')
  toggleConnected(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('isConnected') isConnected: boolean,
  ) {
    return this.svc.toggleConnected(companyId, id, isConnected);
  }
}
