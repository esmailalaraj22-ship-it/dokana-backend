import type { TenantTransactionContext } from '../database/database.types';
import type { AppSettingsInitializationValues } from '../settings/app-settings.types';

export type SubscriptionLifecycleAction = 'activate' | 'extend' | 'cancel' | 'reactivate';

export interface SubscriptionLifecycleCommand {
  operationId: string;
  reason: string;
}

export interface SubscriptionLifecycleResult {
  subscriptionId: string;
  planId: string;
  status: 'active' | 'cancelled';
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  version: bigint;
  action: SubscriptionLifecycleAction;
  changedAt: Date;
  replayed: boolean;
}

export interface SubscriptionLifecycleRecord {
  checkedAt: Date;
  storeId: string;
  storeStatus: 'active' | 'read_only' | 'suspended' | 'archived';
  subscriptionId: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  storedStatus: 'trial' | 'active' | 'past_due' | 'expired' | 'suspended' | 'cancelled' | null;
  effectiveStatus: 'trial' | 'active' | 'past_due' | 'expired' | 'suspended' | 'cancelled' | null;
  startsAt: Date | null;
  endsAt: Date | null;
  cancelledAt: Date | null;
  version: bigint | null;
  current: boolean;
  writeEligible: boolean;
}

export interface SubscriptionHistoryRecord {
  actionId: string;
  adminUserId: string;
  action: string;
  reason: string;
  operationId: string | null;
  previousValues: Record<string, unknown> | null;
  currentValues: Record<string, unknown> | null;
  occurredAt: Date;
}

export type PlatformProvisioningActorContext = Omit<TenantTransactionContext, 'storeId'>;

export interface StoreProvisioningCommand {
  operationId: string;
  ownerUserId: string;
  name: string;
  phone?: string | null;
  reason: string;
  activateSubscription: boolean;
  settings: AppSettingsInitializationValues;
}

export interface StoreProvisioningIdentityResult {
  storeId: string;
  ownerUserId: string;
  membershipId: string;
  subscriptionId: string | null;
  subscriptionStatus: 'active' | null;
  startsAt: Date | null;
  endsAt: Date | null;
  subscriptionVersion: bigint | null;
  changedAt: Date;
  replayed: boolean;
}

export interface StoreProvisioningState {
  storeId: string;
  storeName: string;
  storeStatus: 'active' | 'read_only' | 'suspended' | 'archived';
  ownerCount: bigint;
  ownerUserId: string | null;
  settingsCount: bigint;
  systemCashCount: bigint;
  subscriptionCount: bigint;
  currentSubscriptionId: string | null;
}

export interface StoreProvisioningResult extends StoreProvisioningIdentityResult {
  systemCashAccountId: string;
  state: StoreProvisioningState;
}

export interface PreparedSubscriptionLifecycle {
  action: SubscriptionLifecycleAction;
  operationId: string;
  requestHash: string;
  reason: string;
}

export interface PreparedStoreProvisioning {
  storeId: string;
  operationId: string;
  ownerUserId: string;
  name: string;
  phone: string | null;
  reason: string;
  requestHash: string;
  activateSubscription: boolean;
  settings: AppSettingsInitializationValues;
}
