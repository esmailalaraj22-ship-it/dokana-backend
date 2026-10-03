import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { isUuid } from '../common/logging/request-id';
import { DatabaseService } from '../database/database.service';
import { SystemCashProvisioningService } from '../money-accounts/system-cash-provisioning.service';
import { AppSettingsInitializationService } from '../settings/app-settings-initialization.service';
import { SubscriptionLifecycleRepository } from './subscription-lifecycle.repository';
import type {
  PlatformProvisioningActorContext,
  PreparedStoreProvisioning,
  StoreProvisioningCommand,
  StoreProvisioningResult,
} from './subscription-lifecycle.types';

const requestVersion = 1;
const storeIdNamespace = '330f8db6-2a17-5f42-9bc5-8e8879df0f46';

@Injectable()
export class StoreProvisioningService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: SubscriptionLifecycleRepository,
    private readonly settings: AppSettingsInitializationService,
    private readonly systemCash: SystemCashProvisioningService,
  ) {}

  provision(
    actor: PlatformProvisioningActorContext,
    command: StoreProvisioningCommand,
  ): Promise<StoreProvisioningResult> {
    const input = this.prepare(command);
    const context = { ...actor, storeId: input.storeId };

    return this.database.withTenantTransaction(context, async (transaction) => {
      // Central provisioning has no Store-owned Device yet. Keep the trusted actor,
      // Store, and request context while allowing audit rows to record a null Device.
      await transaction.execute(sql`select set_config('app.device_id', '', true)`);
      const identity = await this.repository.provisionIdentity(transaction, input);
      await this.settings.ensureForStoreInTransaction(transaction, input.storeId, input.settings);
      const cash = await this.systemCash.ensureForStoreInTransaction(transaction, input.storeId);
      const state = await this.repository.readProvisioningState(transaction, input.storeId);

      if (
        state?.storeStatus !== 'active' ||
        state.ownerCount !== 1n ||
        state.ownerUserId !== input.ownerUserId ||
        state.settingsCount !== 1n ||
        state.systemCashCount !== 1n ||
        (input.activateSubscription
          ? state.subscriptionCount !== 1n ||
            state.currentSubscriptionId !== identity.subscriptionId
          : state.subscriptionCount !== 0n || identity.subscriptionId !== null)
      ) {
        throw new Error('Store provisioning foundation is incomplete.');
      }

      return {
        ...identity,
        systemCashAccountId: cash.id,
        state,
      };
    });
  }

  private prepare(command: StoreProvisioningCommand): PreparedStoreProvisioning {
    if (!isUuid(command.operationId) || !isUuid(command.ownerUserId)) {
      throw new TypeError('Store provisioning identifiers must be UUIDs.');
    }
    const operationId = command.operationId.toLowerCase();
    const ownerUserId = command.ownerUserId.toLowerCase();
    const name = command.name.trim();
    const trimmedPhone = command.phone?.trim();
    const phone = trimmedPhone === undefined || trimmedPhone.length === 0 ? null : trimmedPhone;
    const reason = command.reason.trim();
    if (name.length === 0 || reason.length === 0) {
      throw new TypeError('Store provisioning name and reason are required.');
    }
    if (typeof command.activateSubscription !== 'boolean') {
      throw new TypeError('Store provisioning Subscription choice is required.');
    }

    const requestIdentity = {
      version: requestVersion,
      operationId,
      ownerUserId,
      name,
      phone,
      reason,
      activateSubscription: command.activateSubscription,
      settings: {
        dailyReportTimeMinutes: command.settings.dailyReportTimeMinutes,
        defaultCreditPolicy: command.settings.defaultCreditPolicy,
        defaultCreditLimitMinor: command.settings.defaultCreditLimitMinor?.toString() ?? null,
        allowNegativeStock: command.settings.allowNegativeStock,
        lowStockAlertEnabled: command.settings.lowStockAlertEnabled,
        debtAgeAlertDays: command.settings.debtAgeAlertDays,
        backupEnabled: command.settings.backupEnabled,
        backupIntervalHours: command.settings.backupIntervalHours,
        timezoneName: command.settings.timezoneName,
        businessDayMode: command.settings.businessDayMode,
      },
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify(requestIdentity), 'utf8')
      .digest('hex');

    return {
      storeId: this.deriveStoreId(operationId),
      operationId,
      ownerUserId,
      name,
      phone,
      reason,
      requestHash,
      activateSubscription: command.activateSubscription,
      settings: command.settings,
    };
  }

  private deriveStoreId(operationId: string): string {
    const namespaceBytes = Buffer.from(storeIdNamespace.replaceAll('-', ''), 'hex');
    const operationBytes = Buffer.from(operationId.replaceAll('-', ''), 'hex');
    const bytes = createHash('sha1')
      .update(namespaceBytes)
      .update(operationBytes)
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }
}
