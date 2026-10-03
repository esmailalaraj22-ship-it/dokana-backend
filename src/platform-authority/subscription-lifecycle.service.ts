import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import { DatabaseService } from '../database/database.service';
import type { PlatformActorContext } from './platform-authority.types';
import { SubscriptionLifecycleRepository } from './subscription-lifecycle.repository';
import type {
  PreparedSubscriptionLifecycle,
  SubscriptionHistoryRecord,
  SubscriptionLifecycleAction,
  SubscriptionLifecycleCommand,
  SubscriptionLifecycleRecord,
  SubscriptionLifecycleResult,
} from './subscription-lifecycle.types';

const requestVersion = 1;

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: SubscriptionLifecycleRepository,
  ) {}

  activate(
    context: PlatformActorContext,
    command: SubscriptionLifecycleCommand,
  ): Promise<SubscriptionLifecycleResult> {
    return this.execute(context, 'activate', command);
  }

  extend(
    context: PlatformActorContext,
    command: SubscriptionLifecycleCommand,
  ): Promise<SubscriptionLifecycleResult> {
    return this.execute(context, 'extend', command);
  }

  cancel(
    context: PlatformActorContext,
    command: SubscriptionLifecycleCommand,
  ): Promise<SubscriptionLifecycleResult> {
    return this.execute(context, 'cancel', command);
  }

  reactivate(
    context: PlatformActorContext,
    command: SubscriptionLifecycleCommand,
  ): Promise<SubscriptionLifecycleResult> {
    return this.execute(context, 'reactivate', command);
  }

  readLifecycle(context: PlatformActorContext): Promise<SubscriptionLifecycleRecord[]> {
    return this.database.withTenantTransaction(context, (transaction) =>
      this.repository.readLifecycle(transaction, context.storeId),
    );
  }

  readHistory(context: PlatformActorContext): Promise<SubscriptionHistoryRecord[]> {
    return this.database.withTenantTransaction(context, (transaction) =>
      this.repository.readHistory(transaction, context.storeId),
    );
  }

  private execute(
    context: PlatformActorContext,
    action: SubscriptionLifecycleAction,
    command: SubscriptionLifecycleCommand,
  ): Promise<SubscriptionLifecycleResult> {
    const prepared = this.prepare(context.storeId, action, command);
    return this.database.withTenantTransaction(context, (transaction) =>
      this.repository.mutate(transaction, context.storeId, prepared),
    );
  }

  private prepare(
    storeId: string,
    action: SubscriptionLifecycleAction,
    command: SubscriptionLifecycleCommand,
  ): PreparedSubscriptionLifecycle {
    if (!isUuid(storeId) || !isUuid(command.operationId)) {
      throw new TypeError('Subscription lifecycle identifiers must be UUIDs.');
    }
    const reason = command.reason.trim();
    if (reason.length === 0) {
      throw new TypeError('Subscription lifecycle reason is required.');
    }
    const operationId = command.operationId.toLowerCase();
    const canonicalStoreId = storeId.toLowerCase();
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: requestVersion,
          action,
          storeId: canonicalStoreId,
          reason,
        }),
        'utf8',
      )
      .digest('hex');

    return { action, operationId, requestHash, reason };
  }
}
