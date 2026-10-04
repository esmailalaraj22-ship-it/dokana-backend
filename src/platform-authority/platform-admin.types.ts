import type { TenantTransactionContext } from '../database/database.types';

export interface PlatformStoreListRow {
  storeId: string;
  storeName: string;
  storePhone: string | null;
  currencyCode: string;
  storeStatus: 'active' | 'read_only' | 'suspended' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  storeVersion: bigint;
}

export interface PlatformStoreListItemResponse {
  id: string;
  name: string;
  phone: string | null;
  currencyCode: string;
  status: PlatformStoreListRow['storeStatus'];
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface PlatformStoreListResponse {
  items: PlatformStoreListItemResponse[];
  nextCursor: string | null;
}

export interface PlatformSubscriptionResponse {
  checkedAt: string;
  storeId: string;
  storeStatus: string;
  subscriptionId: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  storedStatus: string | null;
  effectiveStatus: string | null;
  startsAt: string | null;
  endsAt: string | null;
  cancelledAt: string | null;
  version: string | null;
  current: boolean;
  writeEligible: boolean;
}

export interface StoreLifecycleCommand {
  operationId: string;
  expectedVersion: string;
  reason: string;
}

export type StoreLifecycleAction = 'suspend' | 'restore';

export interface PreparedStoreLifecycle {
  action: StoreLifecycleAction;
  operationId: string;
  expectedVersion: bigint;
  requestHash: string;
  reason: string;
}

export interface StoreLifecycleResult {
  storeId: string;
  status: 'active' | 'suspended';
  version: bigint;
  action: StoreLifecycleAction;
  changedAt: Date;
  replayed: boolean;
}

export interface StoreLifecycleResponse {
  storeId: string;
  status: StoreLifecycleResult['status'];
  version: string;
  action: StoreLifecycleAction;
  changedAt: string;
  replayed: boolean;
  operationId: string;
}

export interface StoreAdminHistoryRow {
  actionId: string;
  adminUserId: string;
  action: string;
  reason: string;
  operationId: string | null;
  previousValues: Record<string, unknown> | null;
  currentValues: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface StoreAdminHistoryResponse {
  items: {
    actionId: string;
    adminUserId: string;
    action: string;
    reason: string;
    operationId: string | null;
    previousValues: Record<string, unknown> | null;
    currentValues: Record<string, unknown> | null;
    occurredAt: string;
  }[];
  nextCursor: string | null;
}

export type PlatformAdminRequestContext = TenantTransactionContext;
