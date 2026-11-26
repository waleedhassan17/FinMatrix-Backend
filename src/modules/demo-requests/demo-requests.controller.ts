import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PublicRoute } from '../../common/decorators/public.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { assertSuperAdmin } from '../../common/guards/super-admin.util';
import { DemoRequestsService } from './demo-requests.service';
import {
  BookDemoDto,
  DemoAssignDto,
  DemoLinkCompanyDto,
  DemoListQuery,
  DemoNoteDto,
  DemoScheduleDto,
  DemoStatusDto,
} from './dto/demo.dto';

/**
 * Public demo booking — no login, and nothing about any company or person
 * ever comes back: slots are times only, and a booking answers
 * `{ received: true }` whatever happened to it.
 */
@ApiTags('Public — demo booking')
@Controller('public')
export class PublicDemoController {
  constructor(private readonly demos: DemoRequestsService) {}

  @PublicRoute()
  @Get('demo-slots')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Open demo slots (Asia/Karachi) + a form token.' })
  slots(@Query('from') from?: string, @Query('to') to?: string) {
    return this.demos.slots(from, to);
  }

  @PublicRoute()
  @Post('demo-requests')
  // 5 bookings per IP per hour (trust proxy is 1, so req.ip is the client).
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Book a demo.' })
  book(@Body() dto: BookDemoDto, @Req() req: Request) {
    return this.demos.book(dto, req.ip ?? null);
  }
}

/** The demo lead pipeline — super-admins only, every change audited. */
@ApiTags('Admin — demo requests')
@ApiBearerAuth()
@Controller('admin/demo-requests')
export class AdminDemoController {
  constructor(private readonly demos: DemoRequestsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: DemoListQuery) {
    assertSuperAdmin(user);
    return this.demos.list(q);
  }

  @Get('export.csv')
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: DemoListQuery,
    @Res() res: Response,
  ) {
    assertSuperAdmin(user);
    const csv = await this.demos.exportCsv(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="demo-requests-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(`﻿${csv}`);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.demos.detail(id);
  }

  @Patch(':id/status')
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoStatusDto,
  ) {
    assertSuperAdmin(user);
    return this.demos.setStatus(id, user, dto);
  }

  @Post(':id/schedule')
  schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoScheduleDto,
  ) {
    assertSuperAdmin(user);
    return this.demos.schedule(id, user, dto, 'schedule');
  }

  @Post(':id/reschedule')
  reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoScheduleDto,
  ) {
    assertSuperAdmin(user);
    return this.demos.schedule(id, user, dto, 'reschedule');
  }

  @Post(':id/notes')
  note(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoNoteDto,
  ) {
    assertSuperAdmin(user);
    return this.demos.addNote(id, user, dto.body);
  }

  @Patch(':id/assign')
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoAssignDto,
  ) {
    assertSuperAdmin(user);
    return this.demos.assign(id, user, dto.userId ?? null);
  }

  @Post(':id/link-company')
  link(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DemoLinkCompanyDto,
  ) {
    assertSuperAdmin(user);
    return this.demos.linkCompany(id, user, dto.companyId);
  }

  @Post(':id/trial-invite')
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.demos.sendTrialInvite(id, user);
  }

  /** Manual trigger for the reminder sweep (ops + tests). Idempotent. */
  @Post('run-reminders')
  async reminders(@CurrentUser() user: AuthenticatedUser) {
    assertSuperAdmin(user);
    return { sent: await this.demos.sendDueReminders() };
  }
}
