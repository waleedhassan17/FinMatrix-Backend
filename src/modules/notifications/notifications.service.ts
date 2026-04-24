import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationQueryDto } from './dto/notification.dto';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
  ) {}

  async list(userId: string, query: NotificationQueryDto, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('n').where('n.userId = :uid', { uid: userId });
    if (query.isRead !== undefined) qb.andWhere('n.isRead = :r', { r: query.isRead });
    if (query.type) qb.andWhere('n.type = :t', { t: query.type });
    qb.orderBy('n.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async markRead(userId: string, id: string) {
    await this.repo.update({ id, userId }, { isRead: true, readAt: new Date() });
    return { id, read: true };
  }

  async markAllRead(userId: string) {
    await this.repo.update({ userId, isRead: false }, { isRead: true, readAt: new Date() });
    return { readAll: true };
  }

  async unreadCount(userId: string) {
    const count = await this.repo.count({ where: { userId, isRead: false } });
    return { count };
  }
}
