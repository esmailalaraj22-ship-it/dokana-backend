import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';

export type EffectiveAccess = 'write' | 'read_only' | 'blocked';

export type EntitlementDenialReason =
  | 'store_read_only'
  | 'store_suspended'
  | 'store_archived'
  | 'subscription_missing'
  | 'subscription_cancelled'
  | 'subscription_inactive'
  | 'subscription_not_started'
  | 'subscription_expired';

export interface EffectiveEntitlement {
  checkedAt: Date;
  storeId: string;
  storeStatus: 'active' | 'read_only' | 'suspended' | 'archived';
  subscriptionId: string | null;
  subscriptionStatus:
    'trial' | 'active' | 'past_due' | 'expired' | 'suspended' | 'cancelled' | null;
  entitlementStartsAt: Date | null;
  entitlementEndsAt: Date | null;
  effectiveAccess: EffectiveAccess;
  writeEligible: boolean;
  denialReason: EntitlementDenialReason | null;
}

export type LockedEntitlementWork<T> = (
  authority: EffectiveEntitlement,
  transaction: DatabaseTransaction,
) => Promise<T>;

export type PlatformActorContext = TenantTransactionContext;
