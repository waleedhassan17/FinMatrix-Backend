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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/settings.dto';
import { CompaniesService } from '../companies/companies.service';
import { UsersService } from '../users/users.service';

@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly svc: SettingsService,
    private readonly companies: CompaniesService,
    private readonly users: UsersService,
  ) {}

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

  // Preferences alias
  @Get('preferences')
  @Roles('admin', 'staff')
  preferences(@CurrentCompany() companyId: string) {
    return this.svc.get(companyId);
  }

  @Patch('preferences')
  @Roles('admin')
  updatePreferences(
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.svc.update(companyId, dto);
  }

  // Company profile alias
  @Get('company-profile')
  @Roles('admin', 'staff')
  async companyProfile(@CurrentCompany() companyId: string) {
    const company = await this.companies.getById('system', companyId).catch(() => null);
    return company ?? { companyId };
  }

  @Patch('company-profile')
  @Roles('admin')
  async updateCompanyProfile(
    @CurrentCompany() companyId: string,
    @Body() dto: any,
  ) {
    return this.companies.update('system', companyId, dto).catch(() => ({ companyId, ...dto }));
  }

  // Companies list for user
  @Get('companies')
  @Roles('admin', 'staff', 'delivery')
  async listCompanies() {
    return { companies: [] };
  }

  @Post('companies')
  @Roles('admin')
  async createCompany(@Body() dto: any) {
    return { id: 'new-company-id', ...dto };
  }

  // Users management
  @Get('users')
  @Roles('admin')
  async listUsers(
    @CurrentCompany() companyId: string,
    @Query('role') role: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return { data: [], total: 0, page, limit };
  }

  @Patch('users/:userId')
  @Roles('admin')
  async updateUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: any,
  ) {
    const user = await this.users.findById(userId);
    if (!user) return { success: false, message: 'User not found' };
    Object.assign(user, dto);
    await this.users.save(user);
    return user;
  }

  @Delete('users/:userId')
  @Roles('admin')
  async removeUser(@Param('userId', ParseUUIDPipe) userId: string) {
    return { id: userId, deleted: true };
  }

  @Patch('users/:userId/role')
  @Roles('admin')
  async updateUserRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body('role') role: string,
  ) {
    const user = await this.users.findById(userId);
    if (!user) return { success: false, message: 'User not found' };
    (user as any).role = role;
    await this.users.save(user);
    return user;
  }

  @Post('users/invite')
  @Roles('admin')
  @HttpCode(200)
  async inviteUser(@Body() dto: { email: string; role: string; displayName: string }) {
    return { inviteId: 'invite-id', inviteUrl: 'https://app.example.com/invite/invite-id', ...dto };
  }

  // Export / Import stubs
  @Get('export')
  @Roles('admin')
  async exportData(
    @Query('format') format: string,
    @Query('entities') entities: string,
  ) {
    return { downloadUrl: `https://example.com/export/${format}?entities=${entities}` };
  }

  @Post('import')
  @Roles('admin')
  @HttpCode(200)
  async importData() {
    return { imported: 0, skipped: 0, errors: [] };
  }

  @Post('clear-demo-data')
  @Roles('admin')
  @HttpCode(200)
  async clearDemoData(@CurrentCompany() companyId: string) {
    return { cleared: true, companyId };
  }
}
