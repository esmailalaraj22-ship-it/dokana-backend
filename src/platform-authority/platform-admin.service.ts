import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import { DatabaseService } from '../database/database.service';
import { MVP_TIMEZONE_NAME } from '../settings/app-settings.types';
import type { PlatformAdminListQueryDto } from './dto/platform-admin-list-query.dto';
import type { PlatformAdminProvisionStoreDto } from './dto/platform-admin-provision-store.dto';
import type { PlatformAdminStoreLifecycleDto } from './dto/platform-admin-store-lifecycle.dto';
import type { PlatformAdminSubscriptionMutationDto } from './dto/platform-admin-subscription-action.dto';
import { decodePlatformAdminCursor, encodePlatformAdminCursor } from './platform-admin-cursor';
import { PlatformAdminRepository } from './platform-admin.repository';
import type {
  PlatformAdminRequestContext,
  PlatformStoreListItemResponse,
  PlatformStoreListResponse,
  PlatformSubscriptionResponse,
  PreparedStoreLifecycle,
  StoreAdminHistoryResponse,
  StoreLifecycleAction,
  StoreLifecycleResponse,
} from './platform-admin.types';
import { StoreProvisioningService } from './store-provisioning.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import type {
  StoreProvisioningResult,
  SubscriptionLifecycleAction,
  SubscriptionLifecycleRecord,
  SubscriptionLifecycleResult,
} from './subscription-lifecycle.types';

const requestVersion = 1;

function databaseErrorCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PlatformAdminRepository,
    private readonly subscriptions: SubscriptionLifecycleService,
    private readonly provisioning: StoreProvisioningService,
  ) {}

  async listStores(
    context: PlatformAdminRequestContext,
    query: PlatformAdminListQueryDto,
  ): Promise<PlatformStoreListResponse> {
    try {
      const limit = query.limit ?? 50;
      const position =
        query.cursor === undefined ? null : decodePlatformAdminCursor(query.cursor, 'stores');
      const rows = await this.database.withTenantTransaction(context, (transaction) =>
        this.repository.listStores(transaction, position, limit + 1),
      );
      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map((row) => this.mapStore(row)),
        nextCursor:
          hasNextPage && last
            ? encodePlatformAdminCursor('stores', { at: last.createdAt, id: last.storeId })
            : null,
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async getStore(
    caller: PlatformAdminRequestContext,
    storeId: string,
  ): Promise<{
    store: {
      id: string;
      name: string;
      status: string;
      version?: string;
      ownerUserId: string | null;
      ownerCount: string;
      settingsCount: string;
      systemCashCount: string;
      subscriptionCount: string;
    };
    currentSubscription: PlatformSubscriptionResponse | null;
  }> {
    const context = this.targetContext(caller, storeId);
    try {
      const [state, lifecycle, version] = await Promise.all([
        this.provisioning.readState(context),
        this.subscriptions.readLifecycle(context),
        this.database.withTenantTransaction(context, (transaction) =>
          this.repository.readStoreVersion(transaction, context.storeId),
        ),
      ]);
      if (!state) {
        throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found.' });
      }
      const current = lifecycle.find((record) => record.current) ?? null;
      return {
        store: {
          id: state.storeId,
          name: state.storeName,
          status: state.storeStatus,
          version: version?.toString(),
          ownerUserId: state.ownerUserId,
          ownerCount: state.ownerCount.toString(),
          settingsCount: state.settingsCount.toString(),
          systemCashCount: state.systemCashCount.toString(),
          subscriptionCount: state.subscriptionCount.toString(),
        },
        currentSubscription: current ? this.mapSubscription(current) : null,
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async listSubscriptions(
    caller: PlatformAdminRequestContext,
    storeId: string,
  ): Promise<{ items: PlatformSubscriptionResponse[] }> {
    try {
      const records = await this.subscriptions.readLifecycle(this.targetContext(caller, storeId));
      if (records.length === 0) {
        const state = await this.provisioning.readState(this.targetContext(caller, storeId));
        if (!state) {
          throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store not found.' });
        }
      }
      return { items: records.map((record) => this.mapSubscription(record)) };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async listSubscriptionHistory(
    caller: PlatformAdminRequestContext,
    storeId: string,
  ): Promise<{ items: Record<string, unknown>[] }> {
    try {
      const records = await this.subscriptions.readHistory(this.targetContext(caller, storeId));
      return {
        items: records.map((record) => ({
          ...record,
          occurredAt: record.occurredAt.toISOString(),
        })),
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async listHistory(
    caller: PlatformAdminRequestContext,
    storeId: string,
    query: PlatformAdminListQueryDto,
  ): Promise<StoreAdminHistoryResponse> {
    const context = this.targetContext(caller, storeId);
    try {
      const limit = query.limit ?? 50;
      const position =
        query.cursor === undefined
          ? null
          : decodePlatformAdminCursor(query.cursor, 'history', context.storeId);
      const rows = await this.database.withTenantTransaction(context, (transaction) =>
        this.repository.readStoreAdminHistory(transaction, context.storeId, position, limit + 1),
      );
      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
        nextCursor:
          hasNextPage && last
            ? encodePlatformAdminCursor(
                'history',
                { at: last.occurredAt, id: last.actionId },
                context.storeId,
              )
            : null,
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async provisionStore(
    context: PlatformAdminRequestContext,
    body: PlatformAdminProvisionStoreDto,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.provisioning.provision(
        {
          userId: context.userId,
          deviceId: context.deviceId,
          requestId: context.requestId,
        },
        {
          operationId: body.operationId,
          ownerUserId: body.ownerUserId,
          name: body.name,
          phone: body.phone,
          reason: body.reason,
          activateSubscription: body.activateSubscription,
          settings: {
            dailyReportTimeMinutes: body.settings.dailyReportTimeMinutes,
            defaultCreditPolicy: body.settings.defaultCreditPolicy,
            defaultCreditLimitMinor:
              body.settings.defaultCreditLimitMinor === null
                ? null
                : BigInt(body.settings.defaultCreditLimitMinor),
            allowNegativeStock: body.settings.allowNegativeStock,
            lowStockAlertEnabled: body.settings.lowStockAlertEnabled,
            debtAgeAlertDays: body.settings.debtAgeAlertDays,
            backupEnabled: body.settings.backupEnabled,
            backupIntervalHours: body.settings.backupIntervalHours,
            timezoneName: MVP_TIMEZONE_NAME,
            businessDayMode: 'fixed_24h',
          },
        },
      );
      return this.mapProvisioning(result, body.operationId);
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async mutateSubscription(
    caller: PlatformAdminRequestContext,
    storeId: string,
    action: SubscriptionLifecycleAction,
    body: PlatformAdminSubscriptionMutationDto,
  ): Promise<Record<string, unknown>> {
    const context = this.targetContext(caller, storeId);
    try {
      const result = await this.subscriptions[action](context, body);
      return this.mapSubscriptionMutation(result, body.operationId);
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async mutateStoreLifecycle(
    caller: PlatformAdminRequestContext,
    storeId: string,
    action: StoreLifecycleAction,
    body: PlatformAdminStoreLifecycleDto,
  ): Promise<StoreLifecycleResponse> {
    const context = this.targetContext(caller, storeId);
    try {
      const prepared = this.prepareStoreLifecycle(context.storeId, action, body);
      const result = await this.database.withTenantTransaction(context, (transaction) =>
        this.repository.mutateStoreLifecycle(transaction, context.storeId, prepared),
      );
      return {
        storeId: result.storeId,
        status: result.status,
        version: result.version.toString(),
        action: result.action,
        changedAt: result.changedAt.toISOString(),
        replayed: result.replayed,
        operationId: prepared.operationId,
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  private targetContext(
    context: PlatformAdminRequestContext,
    storeId: string,
  ): PlatformAdminRequestContext {
    if (!isUuid(storeId)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    return { ...context, storeId: storeId.toLowerCase() };
  }

  private prepareStoreLifecycle(
    storeId: string,
    action: StoreLifecycleAction,
    body: PlatformAdminStoreLifecycleDto,
  ): PreparedStoreLifecycle {
    const operationId = body.operationId.toLowerCase();
    const expectedVersion = BigInt(body.expectedVersion);
    const reason = body.reason.trim();
    if (reason.length === 0) throw new TypeError('Store lifecycle reason is required.');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: requestVersion,
          storeId,
          action,
          expectedVersion: expectedVersion.toString(),
          reason,
        }),
        'utf8',
      )
      .digest('hex');
    return { action, operationId, expectedVersion, requestHash, reason };
  }

  private mapStore(row: {
    storeId: string;
    storeName: string;
    storePhone: string | null;
    currencyCode: string;
    storeStatus: PlatformStoreListItemResponse['status'];
    createdAt: Date;
    updatedAt: Date;
    storeVersion: bigint;
  }): PlatformStoreListItemResponse {
    return {
      id: row.storeId,
      name: row.storeName,
      phone: row.storePhone,
      currencyCode: row.currencyCode,
      status: row.storeStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.storeVersion.toString(),
    };
  }

  private mapSubscription(record: SubscriptionLifecycleRecord): PlatformSubscriptionResponse {
    return {
      checkedAt: record.checkedAt.toISOString(),
      storeId: record.storeId,
      storeStatus: record.storeStatus,
      subscriptionId: record.subscriptionId,
      planId: record.planId,
      planCode: record.planCode,
      planName: record.planName,
      storedStatus: record.storedStatus,
      effectiveStatus: record.effectiveStatus,
      startsAt: record.startsAt?.toISOString() ?? null,
      endsAt: record.endsAt?.toISOString() ?? null,
      cancelledAt: record.cancelledAt?.toISOString() ?? null,
      version: record.version?.toString() ?? null,
      current: record.current,
      writeEligible: record.writeEligible,
    };
  }

  private mapSubscriptionMutation(
    result: SubscriptionLifecycleResult,
    operationId: string,
  ): Record<string, unknown> {
    return {
      subscriptionId: result.subscriptionId,
      planId: result.planId,
      status: result.status,
      startsAt: result.startsAt.toISOString(),
      endsAt: result.endsAt.toISOString(),
      cancelledAt: result.cancelledAt?.toISOString() ?? null,
      version: result.version.toString(),
      action: result.action,
      changedAt: result.changedAt.toISOString(),
      replayed: result.replayed,
      operationId,
    };
  }

  private mapProvisioning(
    result: StoreProvisioningResult,
    operationId: string,
  ): Record<string, unknown> {
    return {
      storeId: result.storeId,
      ownerUserId: result.ownerUserId,
      membershipId: result.membershipId,
      systemCashAccountId: result.systemCashAccountId,
      subscriptionId: result.subscriptionId,
      subscriptionStatus: result.subscriptionStatus,
      startsAt: result.startsAt?.toISOString() ?? null,
      endsAt: result.endsAt?.toISOString() ?? null,
      subscriptionVersion: result.subscriptionVersion?.toString() ?? null,
      changedAt: result.changedAt.toISOString(),
      replayed: result.replayed,
      operationId,
    };
  }

  private translateDatabaseError(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof ForbiddenException ||
      error instanceof ConflictException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    const code = databaseErrorCode(error);
    if (code === '42501') {
      throw new ForbiddenException({
        code: 'PLATFORM_ADMIN_FORBIDDEN',
        message: 'Platform administration operation is not allowed.',
      });
    }
    if (code === '23505') {
      throw new ConflictException({
        code: 'OPERATION_ID_CONFLICT',
        message: 'The operation ID was already used for a different request.',
      });
    }
    if (code === '40001') {
      throw new ConflictException({
        code: 'STORE_VERSION_CONFLICT',
        message: 'The Store was changed by another operation.',
      });
    }
    if (code === '55000') {
      throw new ConflictException({
        code: 'PLATFORM_LIFECYCLE_CONFLICT',
        message: 'The requested lifecycle transition is not allowed.',
      });
    }
    if (code === '22023') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    throw error;
  }
}
