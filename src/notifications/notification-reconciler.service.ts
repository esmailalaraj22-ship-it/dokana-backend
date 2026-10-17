import { Injectable } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import { NotificationRepository } from './notification.repository';

@Injectable()
export class NotificationReconcilerService {
  constructor(private readonly repository: NotificationRepository) {}

  reconcile(context: TenantTransactionContext): Promise<void> {
    return this.repository.reconcile(context);
  }
}
