import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { ListSubmissionsQueryDto, RejectSubmissionDto } from './dto/billing.dto';

function guardSuperAdmin(user: AuthenticatedUser) {
  if (user.role !== 'super_admin') {
    throw new ForbiddenException('Super admin access required');
  }
}

/**
 * Super-admin payment-submission review (phase2.md step 6). Labels each
 * submission NEW / RENEWAL / UPGRADE; approve runs the shared activation
 * (idempotent, records revenue once); reject requires a reason.
 */
@ApiTags('Billing — Admin')
@ApiBearerAuth()
@Controller('admin/payment-submissions')
export class BillingAdminController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSubmissionsQueryDto,
  ) {
    guardSuperAdmin(user);
    return this.billing.listSubmissions(query.status);
  }

  @Get(':id/screenshot')
  async screenshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    guardSuperAdmin(user);
    const { file, mime } = await this.billing.getScreenshot(id);
    res.setHeader('Content-Type', mime);
    file.stream.pipe(res);
  }

  @Patch(':id/approve')
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    guardSuperAdmin(user);
    return this.billing.approveSubmission(id, user.id);
  }

  @Patch(':id/reject')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectSubmissionDto,
  ) {
    guardSuperAdmin(user);
    return this.billing.rejectSubmission(id, user.id, dto.reason);
  }

  /**
   * Manual trigger for the daily expiry/reminder scan (testing + ops). The scan
   * is idempotent, so calling it any time is safe.
   */
  @Post('run-expiry-scan')
  runExpiryScan(@CurrentUser() user: AuthenticatedUser) {
    guardSuperAdmin(user);
    return this.billing.runExpiryScan();
  }
}
