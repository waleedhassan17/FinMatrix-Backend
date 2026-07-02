import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

/**
 * Minimal in-app notification centre (re-added in phase2.md so subscription
 * renew reminders surface in-app). Per-user (tenancy via userId from the JWT),
 * and intentionally NOT behind CompanyGuard so an inactive/expired account can
 * still read its "renew to restore" reminders. Reminders are created by the
 * billing cron; other modules also emit here.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('isRead') isRead?: string,
    @Query('type') type?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 30,
  ) {
    const query = {
      isRead: isRead === undefined ? undefined : isRead === 'true',
      type,
    };
    return this.svc.list(user.id, query, page, limit);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.unreadCount(user.id);
  }

  @Patch('read-all')
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.markAllRead(user.id);
  }

  @Patch(':id/read')
  read(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.markRead(user.id, id);
  }
}
