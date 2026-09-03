import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { AccountingPeriodPostingContextService } from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { DatabaseService } from '../database/database.service';
import { moneyAccounts, moneyMovements } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from './money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from './money-movement-identity';
import { parseStoredMoneyMovementPostingResponse } from './money-movement-posting-response';
import type {
  MoneyMovementEffectInput,
  MoneyMovementPostingCommand,
  MoneyMovementPostingResponse,
  PostedMoneyMovement,
} from './money-movement.types';

const MONEY_MOVEMENTS_AGGREGATE = 'money_movements';

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseBody: unknown;
}

interface LockedAccount {
  id: string;
  status: 'active' | 'archived';
  availability: 'available' | 'held_by_external_party';
}

@Injectable()
export class MoneyMovementPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
  ) {}

  // Owns one business-write transaction: idempotency claim -> S9 posting context (period
  // FOR SHARE) -> Money Account FOR UPDATE locks (canonical order) -> account-dependent
  // validation under lock -> immutable movement inserts -> processed-operation completion.
  post(
    context: TenantTransactionContext,
    command: MoneyMovementPostingCommand,
    postingDate: string,
  ): Promise<MoneyMovementPostingResponse> {
    const transactionGroupId = deriveTransactionGroupId(command.operationId);

    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const replay = await this.beginMutation(transaction, context, command, transactionGroupId);
      if (replay) {
        return replay;
      }

      const posting = await this.postingContext.resolveForWrite(transaction, context, {
        postingDate,
        operationId: command.operationId,
      });

      const affectedAccountIds = this.collectAccountIds(command);
      const lockedAccounts = await this.lockAccountsInCanonicalOrder(
        transaction,
        context.storeId,
        affectedAccountIds,
      );

      for (const accountId of affectedAccountIds) {
        const account = lockedAccounts.get(accountId);
        if (!account) {
          throw new NotFoundException({
            code: 'MONEY_ACCOUNT_NOT_FOUND',
            message: 'Money Account not found.',
          });
        }
        if (account.status !== 'active' || account.availability !== 'available') {
          throw new ConflictException({
            code: 'MONEY_ACCOUNT_UNAVAILABLE',
            message: 'Money Account is not available for new posting.',
          });
        }
      }

      const movements: PostedMoneyMovement[] = [];
      for (const effect of command.effects) {
        movements.push(
          await this.insertMovement(
            transaction,
            context,
            command,
            effect,
            posting,
            transactionGroupId,
          ),
        );
      }

      const response: MoneyMovementPostingResponse = {
        operationId: command.operationId,
        postingDate: posting.postingDate,
        accountingPeriodId: posting.accountingPeriodId,
        movements,
      };
      await this.applyOperation(transaction, context.storeId, command.operationId, response);
      return response;
    });
  }

  private async insertMovement(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: MoneyMovementPostingCommand,
    effect: MoneyMovementEffectInput,
    posting: AccountingPeriodPostingContext,
    transactionGroupId: string,
  ): Promise<PostedMoneyMovement> {
    const rows = await transaction
      .insert(moneyMovements)
      .values({
        id: deriveMoneyFactId(command.operationId, effect.discriminator),
        storeId: context.storeId,
        accountId: effect.accountId,
        accountingPeriodId: posting.accountingPeriodId,
        movementType: effect.movementType,
        amountDeltaMinor: effect.amountDeltaMinor,
        referenceType: effect.referenceType,
        referenceId: effect.referenceId,
        transactionGroupId,
        transferGroupId: effect.transferGroupId ?? null,
        counterAccountId: effect.counterAccountId ?? null,
        counterpartyName: effect.counterpartyName ?? null,
        externalReference: effect.externalReference ?? null,
        notes: effect.notes ?? null,
        occurredAt: command.occurredAt,
        reversalOfId: effect.reversalOfId ?? null,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(command.operationId, effect.discriminator),
      })
      .returning({
        id: moneyMovements.id,
        accountId: moneyMovements.accountId,
        accountingPeriodId: moneyMovements.accountingPeriodId,
        movementType: moneyMovements.movementType,
        amountDeltaMinor: moneyMovements.amountDeltaMinor,
        transactionGroupId: moneyMovements.transactionGroupId,
        operationId: moneyMovements.operationId,
        occurredAt: moneyMovements.occurredAt,
        createdAt: moneyMovements.createdAt,
      });
    const row = rows[0];
    if (!row) {
      throw new Error('Money Movement insertion did not return a row.');
    }
    return {
      id: row.id,
      accountId: row.accountId,
      accountingPeriodId: row.accountingPeriodId,
      movementType: row.movementType,
      amountDeltaMinor: row.amountDeltaMinor.toString(),
      transactionGroupId: row.transactionGroupId,
      operationId: row.operationId,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private collectAccountIds(command: MoneyMovementPostingCommand): string[] {
    const ids = new Set<string>();
    for (const effect of command.effects) {
      ids.add(effect.accountId);
      if (effect.counterAccountId) {
        ids.add(effect.counterAccountId);
      }
    }
    return [...ids];
  }

  // Canonical, direction-independent lock order (D10-P13): ascending lowercase UUID string.
  private async lockAccountsInCanonicalOrder(
    transaction: DatabaseTransaction,
    storeId: string,
    accountIds: string[],
  ): Promise<Map<string, LockedAccount>> {
    const canonicalOrder = [...accountIds].sort((left, right) => (left < right ? -1 : 1));
    const locked = new Map<string, LockedAccount>();
    for (const accountId of canonicalOrder) {
      const rows = await transaction
        .select({
          id: moneyAccounts.id,
          status: moneyAccounts.status,
          availability: moneyAccounts.availability,
        })
        .from(moneyAccounts)
        .where(and(eq(moneyAccounts.storeId, storeId), eq(moneyAccounts.id, accountId)))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row) {
        locked.set(accountId, row);
      }
    }
    return locked;
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: MoneyMovementPostingCommand,
    transactionGroupId: string,
  ): Promise<MoneyMovementPostingResponse | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (prior) {
      return this.resolveProcessedOperation(
        transaction,
        context,
        command,
        transactionGroupId,
        prior,
      );
    }

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${command.operationId}::uuid,
            ${context.deviceId}::uuid,
            ${MONEY_MOVEMENTS_AGGREGATE},
            ${transactionGroupId}::uuid,
            ${command.action},
            ${command.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') {
        throw error;
      }
      const concurrent = await this.readProcessedOperation(
        transaction,
        context.storeId,
        command.operationId,
      );
      if (!concurrent) {
        throw error;
      }
      return this.resolveProcessedOperation(
        transaction,
        context,
        command,
        transactionGroupId,
        concurrent,
      );
    }

    if (claimed) {
      return null;
    }
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (!existing) {
      throw new Error('Claimed Money Movement operation could not be read.');
    }
    return this.resolveProcessedOperation(
      transaction,
      context,
      command,
      transactionGroupId,
      existing,
    );
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: MoneyMovementPostingCommand,
    transactionGroupId: string,
    existing: ProcessedOperationRow,
  ): Promise<MoneyMovementPostingResponse> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== MONEY_MOVEMENTS_AGGREGATE ||
      existing.aggregateId !== transactionGroupId ||
      existing.action !== command.action ||
      existing.requestHash !== command.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, command, transactionGroupId);
      throw new ConflictException({
        code: 'OPERATION_ID_CONFLICT',
        message: 'Operation ID was reused with a different request.',
      });
    }
    if (existing.status === 'applied') {
      return parseStoredMoneyMovementPostingResponse(existing.responseBody);
    }
    throw new ConflictException({
      code: 'OPERATION_IN_PROGRESS',
      message: 'The operation is still being processed.',
    });
  }

  private async readProcessedOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select
        device_id as "deviceId",
        aggregate_type as "aggregateType",
        aggregate_id as "aggregateId",
        action,
        request_hash as "requestHash",
        status,
        response_body as "responseBody"
      from sync.processed_operations
      where store_id = ${storeId}::uuid and operation_id = ${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: MoneyMovementPostingResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set
        status = 'applied',
        response_code = 201,
        response_body = ${JSON.stringify(response)}::jsonb,
        error_code = null,
        completed_at = clock_timestamp()
      where store_id = ${storeId}::uuid
        and operation_id = ${operationId}::uuid
        and status = 'processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Money Movement operation completion failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: MoneyMovementPostingCommand,
    transactionGroupId: string,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts (
        store_id,
        operation_id,
        entity_type,
        entity_id,
        conflict_type,
        client_payload
      ) values (
        ${context.storeId}::uuid,
        ${command.operationId}::uuid,
        ${MONEY_MOVEMENTS_AGGREGATE},
        ${transactionGroupId}::uuid,
        'duplicate_identity',
        jsonb_build_object('action', ${command.action}::text, 'requestHash', ${command.requestHash}::text)
      )
    `);
  }
}
