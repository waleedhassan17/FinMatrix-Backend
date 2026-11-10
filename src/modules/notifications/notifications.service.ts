import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationQueryDto } from './dto/notification.dto';
import { pagedResponse } from '../../common/utils/paged-response.util';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  async list(
    userId: string,
    query: NotificationQueryDto,
    page: number,
    limit: number,
  ) {
    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.userId = :uid', { uid: userId });
    if (query.isRead !== undefined)
      qb.andWhere('n.isRead = :r', { r: query.isRead });
    if (query.type) qb.andWhere('n.type = :t', { t: query.type });
    qb.orderBy('n.createdAt', 'DESC').addOrderBy('n.id', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return pagedResponse(data, { page, limit, total });
  }

  async markRead(userId: string, id: string) {
    await this.repo.update(
      { id, userId },
      { isRead: true, readAt: new Date() },
    );
    return { id, read: true };
  }

  async markAllRead(userId: string) {
    await this.repo.update(
      { userId, isRead: false },
      { isRead: true, readAt: new Date() },
    );
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
   * Broadcast to every ACTIVE member holding `role` in the company (the owner
   * alert path: role 'admin'). Membership is read with one SQL query on the
   * same connection, so this module still imports no users/companies module.
   * Like create(), it never throws: a failed alert must not break the caller.
   * Returns how many notifications were written.
   */
  async createForRole(
    companyId: string,
    role: string,
    payload: {
      type: string;
      title: string;
      message: string;
      data?: Record<string, unknown>;
    },
  ): Promise<number> {
    let userIds: string[] = [];
    try {
      const rows: Array<{ user_id: string }> = await this.repo.manager.query(
        `SELECT uc.user_id
           FROM user_companies uc
           JOIN users u ON u.id = uc.user_id
          WHERE uc.company_id = $1 AND uc.role = $2 AND u.is_active = true`,
        [companyId, role],
      );
      userIds = rows.map((r) => r.user_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notifications] createForRole lookup failed:', err);
      return 0;
    }
    let written = 0;
    for (const userId of userIds) {
      const row = await this.create({ companyId, userId, ...payload });
      if (row) written++;
    }
    return written;
  }
}
