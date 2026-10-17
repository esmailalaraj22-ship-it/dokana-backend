import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  notificationCursorScopeHash,
} from './notification-cursor';
import { NotificationReconcilerService } from './notification-reconciler.service';
import { NotificationRepository } from './notification.repository';
import { NotificationSchedulerService } from './notification-scheduler.service';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import type {
  NotificationItem,
  NotificationListCriteria,
  NotificationListResponse,
  NotificationReadStateResponse,
} from './notification.types';

type NotificationPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId' | 'sessionExpiresAt'
>;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly reconciler: NotificationReconcilerService,
    private readonly scheduler: NotificationSchedulerService,
  ) {}

  async list(
    principal: NotificationPrincipal,
    context: TenantTransactionContext,
    query: ListNotificationsQueryDto,
  ): Promise<NotificationListResponse> {
    this.assertAuthorized(principal, context);
    this.scheduler.track(context, principal.sessionExpiresAt);
    try {
      await this.reconciler.reconcile(context);
    } catch {
      this.logger.warn({ event: 'notification_reconciliation_failed' });
    }

    const lifecycle = query.lifecycle ?? null;
    const read = query.read === undefined ? null : query.read === 'true';
    const type = query.type ?? null;
    const limit = query.limit ?? 50;
    const scopeHash = notificationCursorScopeHash(lifecycle, read, type);
    const criteria: NotificationListCriteria = {
      lifecycle,
      read,
      type,
      limit,
      anchor: query.cursor ? decodeNotificationCursor(query.cursor, scopeHash) : null,
    };
    const rows = await this.repository.list(context, criteria);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.mapItem(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeNotificationCursor({ createdAt: last.createdAt, id: last.id }, scopeHash)
          : null,
    };
  }

  async setReadState(
    principal: NotificationPrincipal,
    context: TenantTransactionContext,
    notificationId: string,
    read: boolean,
  ): Promise<NotificationReadStateResponse> {
    this.assertAuthorized(principal, context);
    if (!isUUID(notificationId)) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification was not found.',
      });
    }
    const canonicalId = notificationId.toLowerCase();
    const readAt = await this.repository.setReadState(context, canonicalId, read);
    if (readAt === undefined) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification was not found.',
      });
    }
    return {
      id: canonicalId,
      read,
      readAt: readAt?.toISOString() ?? null,
    };
  }

  private assertAuthorized(
    principal: NotificationPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'NOTIFICATION_ACCESS_NOT_ALLOWED',
        message: 'Notification access is not allowed.',
      });
    }
  }

  private mapItem(
    row: Awaited<ReturnType<NotificationRepository['list']>>[number],
  ): NotificationItem {
    return {
      id: row.id,
      type: row.type,
      severity: row.severity,
      title: row.title,
      body: row.body,
      subject: row.entityType && row.entityId ? { type: row.entityType, id: row.entityId } : null,
      lifecycle: row.resolvedAt ? 'resolved' : 'active',
      read: row.readAt !== null,
      readAt: row.readAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
