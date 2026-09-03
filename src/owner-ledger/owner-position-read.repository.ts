import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { ownerPosition } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import type { OwnerPositionResponse } from './owner-ledger.types';

@Injectable()
export class OwnerPositionReadRepository {
  constructor(private readonly database: DatabaseService) {}

  read(context: TenantTransactionContext): Promise<OwnerPositionResponse> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows = await transaction
        .select({
          storeOwesOwnerMinor: ownerPosition.storeOwesOwnerMinor,
          ownerEquityMovementMinor: ownerPosition.ownerEquityMovementMinor,
        })
        .from(ownerPosition)
        .where(eq(ownerPosition.storeId, context.storeId))
        .limit(1);
      const row = rows[0];
      return {
        storeOwesOwnerMinor: row?.storeOwesOwnerMinor.toString() ?? '0',
        ownerEquityMovementMinor: row?.ownerEquityMovementMinor.toString() ?? '0',
      };
    });
  }
}
