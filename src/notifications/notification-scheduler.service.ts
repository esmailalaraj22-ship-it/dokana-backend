import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { TenantTransactionContext } from '../database/database.types';
import { NotificationReconcilerService } from './notification-reconciler.service';

interface ScheduledStore {
  context: TenantTransactionContext;
  validUntil: number;
}

const reconciliationDelayMs = 30_000;
const maximumContextLifetimeMs = 60_000;

@Injectable()
export class NotificationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationSchedulerService.name);
  private readonly stores = new Map<string, ScheduledStore>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly reconciler: NotificationReconcilerService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), reconciliationDelayMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stores.clear();
  }

  track(context: TenantTransactionContext, sessionExpiresAt: Date): void {
    this.stores.set(context.storeId, {
      context: { ...context },
      validUntil: Math.min(sessionExpiresAt.getTime(), Date.now() + maximumContextLifetimeMs),
    });
  }

  private async run(): Promise<void> {
    const now = Date.now();
    const work = [...this.stores.values()];
    this.stores.clear();
    for (const item of work) {
      if (item.validUntil <= now) continue;
      try {
        await this.reconciler.reconcile({ ...item.context, requestId: randomUUID() });
      } catch {
        this.logger.warn({ event: 'notification_reconciliation_failed' });
      }
    }
  }
}
