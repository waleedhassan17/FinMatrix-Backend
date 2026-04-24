import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompaniesService } from './companies.service';
import {
  CreateCompanyDto,
  JoinCompanyDto,
  UpdateCompanyDto,
} from './dto/create-company.dto';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a company and seed default chart of accounts.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCompanyDto) {
    return this.companies.create(user.id, dto);
  }

  @Post('join')
  @ApiOperation({ summary: 'Join an existing company via invite code.' })
  join(@CurrentUser() user: AuthenticatedUser, @Body() dto: JoinCompanyDto) {
    return this.companies.join(user.id, dto);
  }

  @Get(':companyId')
  @ApiOperation({ summary: 'Company detail. Must be a member.' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.getById(user.id, companyId);
  }

  @Patch(':companyId')
  @ApiOperation({ summary: 'Update company details. Admin only.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companies.update(user.id, companyId, dto);
  }

  @Get(':companyId/members')
  @ApiOperation({ summary: 'List all company members. Admin only.' })
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.listMembers(user.id, companyId);
  }

  @Delete(':companyId/members/:userId')
  @ApiOperation({ summary: 'Remove a member. Cannot remove self.' })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    return this.companies.removeMember(user.id, companyId, targetUserId);
  }

  @Post(':companyId/regenerate-code')
  @ApiOperation({ summary: 'Generate a new invite code. Admin only.' })
  regenerateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.regenerateCode(user.id, companyId);
  }
}
