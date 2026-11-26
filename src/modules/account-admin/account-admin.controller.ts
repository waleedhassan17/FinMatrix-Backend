import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Response } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { assertSuperAdmin } from '../../common/guards/super-admin.util';
import { AccountAdminService } from './account-admin.service';

class ReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

class DeleteCompanyDto extends ReasonDto {
  @IsString()
  @MaxLength(200)
  confirmName!: string;

  @IsOptional()
  @IsBoolean()
  allowNewTrial?: boolean;
}

class DeleteUserDto extends ReasonDto {
  @IsString()
  @MaxLength(255)
  confirmEmail!: string;

  @IsOptional()
  @IsBoolean()
  allowNewTrial?: boolean;
}

class DemoFlagDto {
  @IsBoolean()
  isDemo!: boolean;
}

class BulkDto extends ReasonDto {
  @IsIn(['suspend', 'delete'])
  action!: 'suspend' | 'delete';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}

/**
 * Super-admin account control. Suspension is reversible; deletion is
 * permanent and asks the admin to type the company name (or the user's
 * email). Every action is in platform_audit_events.
 */
@ApiTags('Admin — accounts')
@ApiBearerAuth()
@Controller('admin')
export class AccountAdminController {
  constructor(private readonly accounts: AccountAdminService) {}

  // ── Users ──

  @Get('users')
  @ApiOperation({ summary: 'Search users across companies.' })
  users(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('q') q?: string,
  ) {
    assertSuperAdmin(user);
    return this.accounts.searchUsers(q, page, limit);
  }

  @Patch('users/:id/suspend')
  suspendUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    assertSuperAdmin(user);
    return this.accounts.suspendUser(id, user, dto.reason);
  }

  @Patch('users/:id/reinstate')
  reinstateUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.accounts.reinstateUser(id, user);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Permanently delete a user (not a company owner).' })
  deleteUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteUserDto,
  ) {
    assertSuperAdmin(user);
    return this.accounts.deleteUser(id, user, dto);
  }

  // ── Companies ──

  @Patch('companies/:id/demo')
  @ApiOperation({ summary: 'Flag or unflag a company as a demo/test account.' })
  demo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoFlagDto,
  ) {
    assertSuperAdmin(user);
    return this.accounts.setDemo(id, user, dto.isDemo);
  }

  @Get('companies/:id/deletion-preview')
  @ApiOperation({ summary: 'Row counts and effects of deleting a company.' })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.accounts.deletionPreview(id);
  }

  @Delete('companies/:id')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Permanently delete a company and all its data (202; poll the deletion).',
  })
  deleteCompany(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteCompanyDto,
  ) {
    assertSuperAdmin(user);
    return this.accounts.requestCompanyDeletion(id, user, dto);
  }

  @Get('company-deletions/:id')
  deletion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.accounts.getDeletion(id);
  }

  @Post('companies/bulk')
  @ApiOperation({
    summary: 'Bulk suspend, or bulk delete (demo/test accounts only).',
  })
  bulk(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkDto) {
    assertSuperAdmin(user);
    return this.accounts.bulk(user, dto);
  }

  // ── Deleted accounts log ──

  @Get('deleted-accounts')
  deleted(@CurrentUser() user: AuthenticatedUser) {
    assertSuperAdmin(user);
    return this.accounts.deletedAccounts();
  }

  @Get('deleted-accounts/backups/:id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    assertSuperAdmin(user);
    const { file, backup } = await this.accounts.openFinalBackup(id);
    const safe = backup.companyName.replace(/[^\w.-]+/g, '_').slice(0, 80);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="final-backup-${safe}.zip"`,
    );
    if (file.size) res.setHeader('Content-Length', String(file.size));
    file.stream.pipe(res);
  }
}
