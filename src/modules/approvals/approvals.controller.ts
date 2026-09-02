import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ApprovalsService } from './approvals.service';
import { ApprovalRequestsService } from './approval-requests.service';
import { DecideApprovalDto, ListApprovalsQueryDto } from './dto/approval.dto';

@ApiTags('Approvals')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(
    // Reads and cancels come from the core service; only decide needs the
    // dispatcher, and so the module that can reach every domain service.
    private readonly requests: ApprovalRequestsService,
    private readonly svc: ApprovalsService,
  ) {}

  /** Owner sees the whole inbox; staff see only their own requests. */
  @Get()
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'List approval requests' })
  async list(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListApprovalsQueryDto,
  ) {
    const data = await this.requests.list(
      companyId,
      query.status ?? 'pending',
      query.type,
      user,
    );
    return { data, total: data.length };
  }

  /** Badge count for the owner's inbox and the staff member's own list. */
  @Get('pending-count')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Count of requests awaiting a decision' })
  async pendingCount(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { count: await this.requests.pendingCount(companyId, user) };
  }

  @Get(':id')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Get one approval request' })
  getOne(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.requests.getById(companyId, id, user);
  }

  /**
   * Owner only. Deciding is the whole point of the role split, so this is the
   * one route staff must never reach — a 403 at the server, not a hidden
   * button in the app.
   */
  @Post(':id/decide')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve or reject a request (owner only)' })
  @ApiResponse({ status: 403, description: 'Staff, or the requester themselves' })
  decide(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.svc.decide(id, dto, user, companyId);
  }

  /** Withdraw your own pending request. */
  @Post(':id/cancel')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel your own pending request' })
  cancel(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.requests.cancel(id, user, companyId);
  }
}
