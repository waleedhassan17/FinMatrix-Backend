import {
  Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { DeliveryPersonnelService } from './delivery-personnel.service';
import { CreatePersonnelDto, UpdatePersonnelDto } from './dto/delivery-personnel.dto';

@ApiTags('Delivery Personnel')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('delivery-personnel')
export class DeliveryPersonnelController {
  constructor(private readonly svc: DeliveryPersonnelService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('status') status: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, page, limit, status);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreatePersonnelDto,
  ) {
    return this.svc.create(companyId, dto);
  }

  @Get(':userId')
  @Roles('admin', 'staff', 'delivery')
  get(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.getById(companyId, userId);
  }

  @Patch(':userId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdatePersonnelDto,
  ) {
    return this.svc.update(companyId, userId, dto);
  }

  @Patch(':userId/availability')
  @Roles('admin', 'delivery')
  toggle(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.toggleAvailability(companyId, userId);
  }

  @Post(':userId/reset-password')
  @Roles('admin')
  resetPassword(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.resetPassword(companyId, userId);
  }
}
