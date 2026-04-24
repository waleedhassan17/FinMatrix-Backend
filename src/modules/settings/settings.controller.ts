import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/settings.dto';

@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  @Get()
  @Roles('admin', 'staff')
  get(@CurrentCompany() companyId: string) {
    return this.svc.get(companyId);
  }

  @Patch()
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.svc.update(companyId, dto);
  }
}
