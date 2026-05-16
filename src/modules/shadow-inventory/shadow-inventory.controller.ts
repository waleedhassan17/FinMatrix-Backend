import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { ShadowInventoryService } from './shadow-inventory.service';
import { CreateSnapshotDto, UpdateSnapshotDto } from './dto/shadow-inventory.dto';

@ApiTags('Shadow Inventory')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('shadow-inventory')
export class ShadowInventoryController {
  constructor(private readonly svc: ShadowInventoryService) {}

  @Get()
  @Roles('admin', 'staff', 'delivery')
  list(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('personnelId') personnelId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    const pid = (user.role === 'delivery') ? user.id : personnelId;
    return this.svc.list(companyId, pid, page, limit);
  }

  @Post()
  @Roles('delivery')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateSnapshotDto,
  ) {
    return this.svc.create(companyId, dto);
  }

  @Patch(':id')
  @Roles('delivery')
  update(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSnapshotDto,
  ) {
    return this.svc.update(companyId, id, dto);
  }

  @Post('sync/:personnelId')
  @Roles('admin', 'staff', 'delivery')
  sync(
    @CurrentCompany() companyId: string,
    @Param('personnelId', ParseUUIDPipe) personnelId: string,
  ) {
    return this.svc.syncAll(companyId, personnelId);
  }
}
