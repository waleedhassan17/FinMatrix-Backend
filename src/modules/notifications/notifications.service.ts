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

  /**
   * Create a notification row for a single user. Used by other modules
   * (deliveries, inventory-approvals, ...). Errors are swallowed and logged
   * because notification delivery should never break the calling business
   * transaction.
   */
  async create(input: {
    companyId: string;
    userId: string;
    type: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<Notification | null> {
    try {
      const row = this.repo.create({
        companyId: input.companyId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        data: input.data ?? null,
        isRead: false,
        readAt: null,
      });
      return await this.repo.save(row);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notifications] create failed:', err);
      return null;
    }
  }

  /**
   * Broadcast to all users of a given role within a company.
   */
  async createForRole(_companyId: string, _role: string, _payload: {
    type: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    // Resolution requires a UsersRepository lookup; left as a TODO so we
    // don't introduce a circular dep here. Callers that already know the
    // target user IDs should use create() directly.
  }
}
