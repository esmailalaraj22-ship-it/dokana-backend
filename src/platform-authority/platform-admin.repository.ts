import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { stores } from '../database/schema';
import type { DatabaseTransaction } from '../database/database.types';
import type { PlatformAdminCursorPosition } from './platform-admin-cursor';
import type {
  PlatformStoreListRow,
  PreparedStoreLifecycle,
  StoreAdminHistoryRow,
  StoreLifecycleResult,
} from './platform-admin.types';

interface PlatformStoreDatabaseRow extends Omit<
  PlatformStoreListRow,
  'createdAt' | 'updatedAt' | 'storeVersion'
> {
  createdAt: Date | string;
  updatedAt: Date | string;
  storeVersion: string;
}

interface StoreLifecycleDatabaseRow extends Omit<
  StoreLifecycleResult,
  'version' | 'changedAt' | 'status' | 'action'
> {
  storeStatus: StoreLifecycleResult['status'];
  storeVersion: string;
  lifecycleAction: StoreLifecycleResult['action'];
  changedAt: Date | string;
}

interface StoreAdminHistoryDatabaseRow extends Omit<StoreAdminHistoryRow, 'occurredAt'> {
  occurredAt: Date | string;
}

function requiredDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Platform administration authority returned an invalid timestamp.');
  }
  return date;
}

@Injectable()
export class PlatformAdminRepository {
  async readStoreVersion(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<bigint | undefined> {
    const rows = await transaction
      .select({ version: stores.version })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    return rows[0]?.version;
  }

  async listStores(
    transaction: DatabaseTransaction,
    position: PlatformAdminCursorPosition | null,
    limit: number,
  ): Promise<PlatformStoreListRow[]> {
    const result = await transaction.execute(sql`
      select
        store_id as "storeId",
        store_name as "storeName",
        store_phone as "storePhone",
        currency_code as "currencyCode",
        store_status as "storeStatus",
        created_at as "createdAt",
        updated_at as "updatedAt",
        store_version as "storeVersion"
      from ledger.list_platform_stores(
        ${position?.at ?? null}::timestamptz,
        ${position?.id ?? null}::uuid,
        ${limit}::integer
      )
    `);
    return (result.rows as unknown as PlatformStoreDatabaseRow[]).map((row) => ({
      ...row,
      createdAt: requiredDate(row.createdAt),
      updatedAt: requiredDate(row.updatedAt),
      storeVersion: BigInt(row.storeVersion),
    }));
  }

  async mutateStoreLifecycle(
    transaction: DatabaseTransaction,
    storeId: string,
    input: PreparedStoreLifecycle,
  ): Promise<StoreLifecycleResult> {
    const result = await transaction.execute(sql`
      select
        store_id as "storeId",
        store_status as "storeStatus",
        store_version as "storeVersion",
        lifecycle_action as "lifecycleAction",
        changed_at as "changedAt",
        replayed
      from ledger.manage_store_lifecycle(
        ${storeId}::uuid,
        ${input.action}::text,
        ${input.expectedVersion}::bigint,
        ${input.operationId}::uuid,
        ${input.requestHash}::text,
        ${input.reason}::text
      )
    `);
    const row = result.rows[0] as StoreLifecycleDatabaseRow | undefined;
    if (!row) throw new Error('Store lifecycle authority returned no result.');
    return {
      storeId: row.storeId,
      status: row.storeStatus,
      version: BigInt(row.storeVersion),
      action: row.lifecycleAction,
      changedAt: requiredDate(row.changedAt),
      replayed: row.replayed,
    };
  }

  async readStoreAdminHistory(
    transaction: DatabaseTransaction,
    storeId: string,
    position: PlatformAdminCursorPosition | null,
    limit: number,
  ): Promise<StoreAdminHistoryRow[]> {
    const result = await transaction.execute(sql`
      select
        action_id as "actionId",
        admin_user_id as "adminUserId",
        action,
        reason,
        operation_id as "operationId",
        previous_values as "previousValues",
        current_values as "currentValues",
        occurred_at as "occurredAt"
      from ledger.read_store_admin_history(
        ${storeId}::uuid,
        ${position?.at ?? null}::timestamptz,
        ${position?.id ?? null}::uuid,
        ${limit}::integer
      )
    `);
    return (result.rows as unknown as StoreAdminHistoryDatabaseRow[]).map((row) => ({
      ...row,
      occurredAt: requiredDate(row.occurredAt),
    }));
  }
}
