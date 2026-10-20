import { Injectable } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import { RecoveryHealthService } from '../recovery/recovery-health.service';
import { NotificationRepository } from './notification.repository';

@Injectable()
export class NotificationReconcilerService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly recoveryHealth: RecoveryHealthService,
  ) {}

  async reconcile(context: TenantTransactionContext): Promise<void> {
    const backupCause = await this.recoveryHealth.notificationCause(context.storeId);
    await this.repository.reconcile(context, backupCause ? [backupCause] : []);
  }
}
