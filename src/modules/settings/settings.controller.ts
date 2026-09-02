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
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { SettingsService } from './settings.service';
import { CompanyUsersService } from './company-users.service';
import { UpdateSettingsDto } from './dto/settings.dto';
import {
  CreateCompanyUserDto,
  ResetCompanyUserPasswordDto,
  UpdateCompanyUserRoleDto,
} from './dto/company-user.dto';
import { CompaniesService } from '../companies/companies.service';
import { UsersService } from '../users/users.service';

@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly svc: SettingsService,
    private readonly companies: CompaniesService,
    private readonly users: UsersService,
    private readonly companyUsers: CompanyUsersService,
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

  // ── Team management ───────────────────────────────────────────────────────
  // Every route here is @Roles('admin'): staff must get a 403 at the server,
  // not merely a hidden button. @RequiresFeature('multiUser') is the tier gate
  // on top of that.

  @Get('users')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async listUsers(@CurrentCompany() companyId: string) {
    const data = await this.companyUsers.list(companyId);
    return { data, total: data.length };
  }

  @Post('users')
  @RequiresFeature('multiUser')
  @Roles('admin')
  @HttpCode(201)
  async createUser(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCompanyUserDto,
  ) {
    return this.companyUsers.create(companyId, dto, user.id);
  }

  @Patch('users/:userId/role')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async updateUserRole(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateCompanyUserRoleDto,
  ) {
    return this.companyUsers.changeRole(companyId, userId, dto.role, user.id);
  }

  @Patch('users/:userId/deactivate')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async deactivateUser(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.companyUsers.setActive(companyId, userId, false, user.id);
  }

  @Patch('users/:userId/activate')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async activateUser(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.companyUsers.setActive(companyId, userId, true, user.id);
  }

  /**
   * Re-issue a password and return it once, for the owner to pass on. This is
   * the only recovery path for an owner-created account — there is no
   * self-service reset, because the account has no inbox.
   */
  @Post('users/:userId/reset-password')
  @RequiresFeature('multiUser')
  @Roles('admin')
  @HttpCode(200)
  async resetUserPassword(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ResetCompanyUserPasswordDto,
  ) {
    return this.companyUsers.resetPassword(companyId, userId, dto, user.id);
  }

  /** Show the stored password again. Audited on every read. */
  @Get('users/:userId/credential')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async revealUserCredential(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.companyUsers.revealCredential(companyId, userId, user.id);
  }

  /**
   * @deprecated Team members get a username and a password now, not an emailed
   * invite link. Kept so older app builds keep working: the email's local part
   * becomes the username and a password is generated, so the call still
   * produces a usable account — the caller just gets credentials back instead
   * of an invite URL.
   */
  @Post('users/invite')
  @RequiresFeature('multiUser')
  @Roles('admin')
  @HttpCode(200)
  async inviteUser(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { email: string; role?: string; displayName?: string },
  ) {
    const local = (dto.email ?? '').split('@')[0]?.toLowerCase() ?? '';
    // Strip anything the username rule rejects, then pad a too-short handle.
    const username = (local.replace(/[^a-z0-9._-]/g, '') || 'member').padEnd(3, '0');
    return this.companyUsers.create(
      companyId,
      {
        name: dto.displayName?.trim() || local || dto.email,
        username,
        password: this.companyUsers.generatePassword(),
        // Anything that isn't 'admin' becomes staff: the old endpoint accepted
        // free-form roles like 'member' that have no meaning here.
        role: dto.role === 'admin' ? 'admin' : 'staff',
        email: dto.email,
      },
      user.id,
    );
  }

  /**
   * @deprecated Kept so older app builds keep working. Team members are
   * created with a username and a password now, not emailed an invite link.
   */
  @Patch('users/:userId')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async updateUser(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateCompanyUserRoleDto,
  ) {
    return this.companyUsers.changeRole(companyId, userId, dto.role, user.id);
  }

  /**
   * @deprecated Accounts are deactivated, never deleted — the ledger
   * references them. Forwards to deactivate so old clients do no harm.
   */
  @Delete('users/:userId')
  @RequiresFeature('multiUser')
  @Roles('admin')
  async removeUser(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.companyUsers.setActive(companyId, userId, false, user.id);
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
