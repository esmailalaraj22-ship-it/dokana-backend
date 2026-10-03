import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';
import type {
  PreparedStoreProvisioning,
  PreparedSubscriptionLifecycle,
  StoreProvisioningIdentityResult,
  StoreProvisioningState,
  SubscriptionHistoryRecord,
  SubscriptionLifecycleRecord,
  SubscriptionLifecycleResult,
} from './subscription-lifecycle.types';

interface SubscriptionMutationRow {
  subscriptionId: string;
  planId: string;
  subscriptionStatus: 'active' | 'cancelled';
  startsAt: Date | string;
  endsAt: Date | string;
  cancelledAt: Date | string | null;
  subscriptionVersion: string;
  lifecycleAction: PreparedSubscriptionLifecycle['action'];
  changedAt: Date | string;
  replayed: boolean;
}

interface SubscriptionLifecycleRow {
  checkedAt: Date | string;
  storeId: string;
  storeStatus: SubscriptionLifecycleRecord['storeStatus'];
  subscriptionId: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  subscriptionStatus: SubscriptionLifecycleRecord['storedStatus'];
  effectiveStatus: SubscriptionLifecycleRecord['effectiveStatus'];
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  cancelledAt: Date | string | null;
  subscriptionVersion: string | null;
  currentSubscription: boolean;
  writeEligible: boolean;
}

interface StoreIdentityRow {
  storeId: string;
  ownerUserId: string;
  membershipId: string;
  subscriptionId: string | null;
  subscriptionStatus: 'active' | null;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  subscriptionVersion: string | null;
  changedAt: Date | string;
  replayed: boolean;
}

interface StoreStateRow {
  storeId: string;
  storeName: string;
  storeStatus: StoreProvisioningState['storeStatus'];
  ownerCount: string;
  ownerUserId: string | null;
  settingsCount: string;
  systemCashCount: string;
  subscriptionCount: string;
  currentSubscriptionId: string | null;
}

interface SubscriptionHistoryRow extends Omit<SubscriptionHistoryRecord, 'occurredAt'> {
  occurredAt: Date | string;
}

function requiredDate(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Subscription authority returned an invalid timestamp.');
  }
  return parsed;
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : requiredDate(value);
}

@Injectable()
export class SubscriptionLifecycleRepository {
  async mutate(
    transaction: DatabaseTransaction,
    storeId: string,
    input: PreparedSubscriptionLifecycle,
  ): Promise<SubscriptionLifecycleResult> {
    const result = await transaction.execute(sql`
      select
        subscription_id as "subscriptionId",
        plan_id as "planId",
        subscription_status as "subscriptionStatus",
        starts_at as "startsAt",
        ends_at as "endsAt",
        cancelled_at as "cancelledAt",
        subscription_version as "subscriptionVersion",
        lifecycle_action as "lifecycleAction",
        changed_at as "changedAt",
        replayed
      from ledger.manage_subscription_lifecycle(
        ${storeId}::uuid,
        ${input.action}::text,
        ${input.operationId}::uuid,
        ${input.requestHash}::text,
        ${input.reason}::text
      )
    `);
    const row = result.rows[0] as SubscriptionMutationRow | undefined;
    if (!row) {
      throw new Error('Subscription lifecycle authority returned no result.');
    }

    return {
      subscriptionId: row.subscriptionId,
      planId: row.planId,
      status: row.subscriptionStatus,
      startsAt: requiredDate(row.startsAt),
      endsAt: requiredDate(row.endsAt),
      cancelledAt: nullableDate(row.cancelledAt),
      version: BigInt(row.subscriptionVersion),
      action: row.lifecycleAction,
      changedAt: requiredDate(row.changedAt),
      replayed: row.replayed,
    };
  }

  async readLifecycle(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<SubscriptionLifecycleRecord[]> {
    const result = await transaction.execute(sql`
      select
        checked_at as "checkedAt",
        store_id as "storeId",
        store_status as "storeStatus",
        subscription_id as "subscriptionId",
        plan_id as "planId",
        plan_code as "planCode",
        plan_name as "planName",
        subscription_status as "subscriptionStatus",
        effective_status as "effectiveStatus",
        starts_at as "startsAt",
        ends_at as "endsAt",
        cancelled_at as "cancelledAt",
        subscription_version as "subscriptionVersion",
        current_subscription as "currentSubscription",
        write_eligible as "writeEligible"
      from ledger.read_subscription_lifecycle(${storeId}::uuid)
    `);

    return (result.rows as unknown as SubscriptionLifecycleRow[]).map((row) => ({
      checkedAt: requiredDate(row.checkedAt),
      storeId: row.storeId,
      storeStatus: row.storeStatus,
      subscriptionId: row.subscriptionId,
      planId: row.planId,
      planCode: row.planCode,
      planName: row.planName,
      storedStatus: row.subscriptionStatus,
      effectiveStatus: row.effectiveStatus,
      startsAt: nullableDate(row.startsAt),
      endsAt: nullableDate(row.endsAt),
      cancelledAt: nullableDate(row.cancelledAt),
      version: row.subscriptionVersion === null ? null : BigInt(row.subscriptionVersion),
      current: row.currentSubscription,
      writeEligible: row.writeEligible,
    }));
  }

  async readHistory(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<SubscriptionHistoryRecord[]> {
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
      from ledger.read_subscription_history(${storeId}::uuid)
    `);
    return (result.rows as unknown as SubscriptionHistoryRow[]).map((row) => ({
      ...row,
      occurredAt: requiredDate(row.occurredAt),
    }));
  }

  async provisionIdentity(
    transaction: DatabaseTransaction,
    input: PreparedStoreProvisioning,
  ): Promise<StoreProvisioningIdentityResult> {
    const result = await transaction.execute(sql`
      select
        store_id as "storeId",
        owner_user_id as "ownerUserId",
        membership_id as "membershipId",
        subscription_id as "subscriptionId",
        subscription_status as "subscriptionStatus",
        starts_at as "startsAt",
        ends_at as "endsAt",
        subscription_version as "subscriptionVersion",
        changed_at as "changedAt",
        replayed
      from ledger.provision_store_identity(
        ${input.storeId}::uuid,
        ${input.ownerUserId}::uuid,
        ${input.name}::text,
        ${input.phone}::text,
        ${input.operationId}::uuid,
        ${input.requestHash}::text,
        ${input.reason}::text,
        ${input.activateSubscription}::boolean
      )
    `);
    const row = result.rows[0] as StoreIdentityRow | undefined;
    if (!row) {
      throw new Error('Store provisioning authority returned no result.');
    }

    return {
      ...row,
      startsAt: nullableDate(row.startsAt),
      endsAt: nullableDate(row.endsAt),
      subscriptionVersion:
        row.subscriptionVersion === null ? null : BigInt(row.subscriptionVersion),
      changedAt: requiredDate(row.changedAt),
    };
  }

  async readProvisioningState(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<StoreProvisioningState | undefined> {
    const result = await transaction.execute(sql`
      select
        store_id as "storeId",
        store_name as "storeName",
        store_status as "storeStatus",
        owner_count as "ownerCount",
        owner_user_id as "ownerUserId",
        settings_count as "settingsCount",
        system_cash_count as "systemCashCount",
        subscription_count as "subscriptionCount",
        current_subscription_id as "currentSubscriptionId"
      from ledger.read_store_provisioning_state(${storeId}::uuid)
    `);
    const row = result.rows[0] as StoreStateRow | undefined;
    if (!row) return undefined;

    return {
      ...row,
      ownerCount: BigInt(row.ownerCount),
      settingsCount: BigInt(row.settingsCount),
      systemCashCount: BigInt(row.systemCashCount),
      subscriptionCount: BigInt(row.subscriptionCount),
    };
  }
}
