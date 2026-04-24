import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationQueryDto } from './dto/notification.dto';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(
    @Query() query: NotificationQueryDto,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
    @Query('userId') userId: string,
  ) {
    return this.svc.list(userId, query, page, limit);
  }

  @Get('unread-count')
  unreadCount(@Query('userId') userId: string) {
    return this.svc.unreadCount(userId);
  }

  @Patch(':id/read')
  markRead(@Param('id', ParseUUIDPipe) id: string, @Query('userId') userId: string) {
    return this.svc.markRead(userId, id);
  }

  @Post('read-all')
  markAllRead(@Query('userId') userId: string) {
    return this.svc.markAllRead(userId);
  }
}
