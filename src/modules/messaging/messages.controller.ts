import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import { MessagesService } from './messages.service';
import {
  ContactHealthQueryDto,
  ManualShareDto,
  SendMessageDto,
  StatsQueryDto,
  TimelineQueryDto,
} from './dto/messaging.dto';

/** FinMatrix Connect messages: timelines, resend, explicit send, manual-share log, stats, contact health. */
@ApiTags('messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('whatsappConnect')
@Roles('admin', 'staff')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  @ApiOperation({
    summary: "A document's messages, newest first, with status history.",
  })
  timeline(@CurrentCompany() companyId: string, @Query() q: TimelineQueryDto) {
    return this.messages.timeline(companyId, q.docType, q.docId);
  }

  // Literal routes before ':id'.
  @Get('stats')
  stats(@CurrentCompany() companyId: string, @Query() q: StatsQueryDto) {
    return this.messages.stats(companyId, q.from, q.to);
  }

  @Get('contact-health')
  contactHealth(
    @CurrentCompany() companyId: string,
    @Query() q: ContactHealthQueryDto,
  ) {
    return this.messages.contactHealth(companyId, q);
  }

  @Post('send')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send now (an "ask each time" event, or a payment reminder).',
  })
  send(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.send(companyId, user.id, dto);
  }

  @Post('manual-share')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record a wa.me hand-off (no provider call).' })
  manualShare(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ManualShareDto,
  ) {
    return this.messages.manualShare(companyId, user.id, dto);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messages.resend(companyId, id, user.id);
  }

  @Get(':id/media')
  @ApiOperation({ summary: 'The PDF exactly as it was sent.' })
  async media(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const { file, filename } = await this.messages.media(companyId, id);
    res.setHeader('Content-Type', file.mimeType ?? 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    if (file.size) res.setHeader('Content-Length', String(file.size));
    file.stream.pipe(res);
  }
}
