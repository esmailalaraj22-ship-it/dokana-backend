import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { moneyAccounts } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { uniqueConstraint } from './money-account-database-error';
import { SYSTEM_CASH_MONEY_ACCOUNT } from './money-account.types';
import type {
  MoneyAccountMutationRow,
  SystemCashProvisioningResult,
} from './money-account-write.types';
import {
  requireSingleValidSystemCash,
  SYSTEM_CASH_NORMALIZED_NAME,
  SystemCashInvariantError,
} from './system-cash-invariants';

const cashSelection = {
  id: moneyAccounts.id,
  name: moneyAccounts.name,
  normalizedName: moneyAccounts.normalizedName,
  accountType: moneyAccounts.accountType,
  availability: moneyAccounts.availability,
  isDefault: moneyAccounts.isDefault,
  status: moneyAccounts.status,
  archivedAt: moneyAccounts.archivedAt,
  createdAt: moneyAccounts.createdAt,
  updatedAt: moneyAccounts.updatedAt,
  version: moneyAccounts.version,
} as const;

@Injectable()
export class SystemCashProvisioningService {
  constructor(private readonly database: DatabaseService) {}

  ensureForStore(context: TenantTransactionContext): Promise<SystemCashProvisioningResult> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const existing = await this.readCashRows(transaction, context.storeId);
      if (existing.length > 0) {
        return requireSingleValidSystemCash(existing);
      }

      try {
        const created = await transaction.transaction(async (savepoint) => {
          const rows = await savepoint
            .insert(moneyAccounts)
            .values({
              id: randomUUID(),
              storeId: context.storeId,
              name: SYSTEM_CASH_MONEY_ACCOUNT.name,
              normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
              accountType: SYSTEM_CASH_MONEY_ACCOUNT.accountType,
              availability: SYSTEM_CASH_MONEY_ACCOUNT.availability,
              isDefault: SYSTEM_CASH_MONEY_ACCOUNT.isDefault,
              status: 'active',
              archivedAt: null,
              deviceId: null,
              operationId: randomUUID(),
            })
            .returning(cashSelection);
          const row = rows[0];
          if (!row) {
            throw new Error('System Cash provisioning did not return a row.');
          }
          return row;
        });
        return requireSingleValidSystemCash([created]);
      } catch (error) {
        if (uniqueConstraint(error) === undefined) {
          throw error;
        }
        const winner = await this.readCashRows(transaction, context.storeId);
        if (winner.length === 0) {
          throw new SystemCashInvariantError('cash_identity_conflict');
        }
        return requireSingleValidSystemCash(winner);
      }
    });
  }

  private readCashRows(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<MoneyAccountMutationRow[]> {
    return transaction
      .select(cashSelection)
      .from(moneyAccounts)
      .where(and(eq(moneyAccounts.storeId, storeId), eq(moneyAccounts.accountType, 'cash')))
      .for('update');
  }
}
