import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction } from '../database/database.types';
import type {
  EffectiveAccess,
  EffectiveEntitlement,
  EntitlementDenialReason,
  LockedEntitlementWork,
  PlatformActorContext,
} from './platform-authority.types';

interface EffectiveEntitlementRow {
  checkedAt: Date;
  storeId: string;
  storeStatus: EffectiveEntitlement['storeStatus'];
  subscriptionId: string | null;
  subscriptionStatus: EffectiveEntitlement['subscriptionStatus'];
  entitlementStartsAt: Date | null;
  entitlementEndsAt: Date | null;
  effectiveAccess: EffectiveAccess;
  writeEligible: boolean;
  denialReason: EntitlementDenialReason | null;
}

@Injectable()
export class PlatformAuthorityService {
  constructor(private readonly database: DatabaseService) {}

  async isCurrentActorPlatformAdmin(context: PlatformActorContext): Promise<boolean> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute(sql`
        select ledger.current_actor_is_platform_admin() as "isPlatformAdmin"
      `);
      const row = result.rows[0] as { isPlatformAdmin?: unknown } | undefined;
      return row?.isPlatformAdmin === true;
    });
  }

  async withLockedEffectiveEntitlement<T>(
    context: PlatformActorContext,
    work: LockedEntitlementWork<T>,
  ): Promise<T> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const authority = await this.lockEffectiveEntitlement(transaction, context.storeId);
      return work(authority, transaction);
    });
  }

  private async lockEffectiveEntitlement(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<EffectiveEntitlement> {
    const result = await transaction.execute(sql`
      select
        checked_at as "checkedAt",
        store_id as "storeId",
        store_status as "storeStatus",
        subscription_id as "subscriptionId",
        subscription_status as "subscriptionStatus",
        entitlement_starts_at as "entitlementStartsAt",
        entitlement_ends_at as "entitlementEndsAt",
        effective_access as "effectiveAccess",
        write_eligible as "writeEligible",
        denial_reason as "denialReason"
      from ledger.lock_effective_entitlement(${storeId}::uuid)
    `);
    const row = result.rows[0] as EffectiveEntitlementRow | undefined;

    if (!row) {
      throw new Error('Effective entitlement authority returned no result.');
    }

    return row;
  }
}
