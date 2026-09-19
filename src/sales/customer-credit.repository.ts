import { HttpException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { customerLedgerEntries } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type { CustomerFinancialCommand } from './customer-credit-command';
import { parseStoredCustomerFinancialResponse } from './customer-credit-response';
import type {
  CustomerFinancialFailure,
  CustomerFinancialFailureCode,
  CustomerFinancialLedgerEffect,
  CustomerFinancialResponse,
  CustomerFinancialResult,
} from './customer-credit.types';
import {
  CustomerReceivablePlanningError,
  CustomerReceivableSettlementRepository,
} from './customer-receivable-settlement.repository';

const AGGREGATE = 'customer_financial_adjustments';

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseCode: number | null;
  responseBody: unknown;
  errorCode: string | null;
}

interface FailureResult {
  ok: false;
  error: CustomerFinancialFailure;
}

const definitions: Readonly<Record<CustomerFinancialFailureCode, CustomerFinancialFailure>> = {
  ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: {
    code: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
    message: 'Accounting Period identity or boundaries are inconsistent.',
    statusCode: 409,
  },
  ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: {
    code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    message: 'Accounting Period is not eligible for posting.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING: {
    code: 'CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING',
    message: 'Receivable allocation exceeds the current outstanding amount.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING: {
    code: 'CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING',
    message: 'Receivable adjustment exceeds the current outstanding amount.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH: {
    code: 'CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH',
    message: 'Receivable target belongs to a different Customer.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Receivable target is inconsistent.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE: {
    code: 'CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE',
    message: 'Receivable target is not active.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_NOT_FOUND: {
    code: 'CUSTOMER_COLLECTION_TARGET_NOT_FOUND',
    message: 'Receivable target not found.',
    statusCode: 404,
  },
  CUSTOMER_CREDIT_INSUFFICIENT: {
    code: 'CUSTOMER_CREDIT_INSUFFICIENT',
    message: 'Customer Credit is insufficient.',
    statusCode: 409,
  },
  CUSTOMER_NOT_FOUND: {
    code: 'CUSTOMER_NOT_FOUND',
    message: 'Customer not found.',
    statusCode: 404,
  },
  CUSTOMER_UNAVAILABLE: {
    code: 'CUSTOMER_UNAVAILABLE',
    message: 'Customer is not available for new financial operations.',
    statusCode: 409,
  },
  MONEY_ACCOUNT_NOT_FOUND: {
    code: 'MONEY_ACCOUNT_NOT_FOUND',
    message: 'Money Account not found.',
    statusCode: 404,
  },
  MONEY_ACCOUNT_UNAVAILABLE: {
    code: 'MONEY_ACCOUNT_UNAVAILABLE',
    message: 'Money Account is not available for new posting.',
    statusCode: 409,
  },
  OPERATION_ID_CONFLICT: {
    code: 'OPERATION_ID_CONFLICT',
    message: 'Operation ID was reused with a different request.',
    statusCode: 409,
  },
  OPERATION_IN_PROGRESS: {
    code: 'OPERATION_IN_PROGRESS',
    message: 'The operation is still being processed.',
    statusCode: 409,
  },
};

class CustomerFinancialRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'CustomerFinancialRejectedError';
  }
}

function failure(code: CustomerFinancialFailureCode): FailureResult {
  return { ok: false, error: definitions[code] };
}

function reject(code: CustomerFinancialFailureCode): never {
  throw new CustomerFinancialRejectedError(failure(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class CustomerCreditRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly receivables: CustomerReceivableSettlementRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    postingDate: string,
  ): Promise<CustomerFinancialResult> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, command);
      if (begun) return begun;
      try {
        const response = await transaction.transaction((savepoint) =>
          this.insertWithinTransaction(savepoint, context, command, postingDate),
        );
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  private async insertWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    postingDate: string,
  ): Promise<CustomerFinancialResponse> {
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    try {
      await this.receivables.lockActiveCustomer(transaction, context.storeId, command.customerId);
    } catch (error) {
      this.translatePlanningError(error);
    }
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${this.auditReason(command)}::text, true)`,
    );
    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    let ledgerEffects: CustomerFinancialLedgerEffect[];
    let moneyMovement: PostedMoneyMovement | null = null;

    if (command.action === 'refund_customer_credit') {
      ledgerEffects = [
        await this.insertCreditRefund(transaction, context, command, posting, transactionGroupId),
      ];
      const effect = ledgerEffects[0];
      if (!effect || !command.moneyAccountId) {
        throw new Error('Customer Credit refund state is incomplete.');
      }
      moneyMovement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: 'customer-credit-refund-money',
          accountId: command.moneyAccountId,
          amountDeltaMinor: -command.amountMinor,
          movementType: 'customer_refund',
          referenceType: 'customer_credit_refund',
          referenceId: effect.id,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          notes: command.reason,
        },
      );
    } else {
      ledgerEffects = await this.insertTargetedEffects(
        transaction,
        context,
        command,
        posting,
        transactionGroupId,
      );
    }

    return {
      operationId: command.operationId,
      action: command.action,
      customerId: command.customerId,
      amountMinor: command.amountMinor.toString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      transactionGroupId,
      ledgerEffects,
      moneyMovement,
    };
  }

  private async insertCreditRefund(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    posting: AccountingPeriodPostingContext,
    transactionGroupId: string,
  ): Promise<CustomerFinancialLedgerEffect> {
    const availableCredit = await this.receivables.readAvailableCredit(
      transaction,
      context.storeId,
      command.customerId,
    );
    if (command.amountMinor > availableCredit) reject('CUSTOMER_CREDIT_INSUFFICIENT');
    if (!command.moneyAccountId) throw new Error('Customer Credit refund account is missing.');
    await this.lockMoneyAccount(transaction, context.storeId, command.moneyAccountId);
    const discriminator = 'customer-credit-refund-ledger';
    const id = deriveMoneyFactId(command.operationId, discriminator);
    return this.insertLedgerEffect(transaction, context, command, posting, {
      id,
      discriminator,
      entryType: 'refund',
      receivableDeltaMinor: 0n,
      creditDeltaMinor: -command.amountMinor,
      sourceSaleId: null,
      referenceType: 'customer_credit_refund',
      referenceId: id,
      targetType: null,
      targetId: null,
      transactionGroupId,
    });
  }

  private async insertTargetedEffects(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    posting: AccountingPeriodPostingContext,
    transactionGroupId: string,
  ): Promise<CustomerFinancialLedgerEffect[]> {
    if (!command.allocationMode) throw new Error('Receivable allocation mode is missing.');
    if (command.action === 'apply_customer_credit') {
      const availableCredit = await this.receivables.readAvailableCredit(
        transaction,
        context.storeId,
        command.customerId,
      );
      if (command.amountMinor > availableCredit) reject('CUSTOMER_CREDIT_INSUFFICIENT');
    }
    let plan;
    try {
      plan = (
        await this.receivables.buildPlan(
          transaction,
          context.storeId,
          command.customerId,
          command.allocationMode,
          command.amountMinor,
          command.allocations,
          false,
        )
      ).plan;
    } catch (error) {
      this.translatePlanningError(error);
    }

    const effects: CustomerFinancialLedgerEffect[] = [];
    for (const target of plan) {
      const discriminator = `${command.action}:${target.targetType}:${target.targetId}`;
      effects.push(
        await this.insertLedgerEffect(transaction, context, command, posting, {
          id: deriveMoneyFactId(command.operationId, discriminator),
          discriminator,
          entryType: command.action === 'apply_customer_credit' ? 'credit_used' : 'settlement',
          receivableDeltaMinor: -target.amountMinor,
          creditDeltaMinor: command.action === 'apply_customer_credit' ? -target.amountMinor : 0n,
          sourceSaleId: target.targetType === 'sale_receivable' ? target.targetId : null,
          referenceType:
            target.targetType === 'sale_receivable' ? 'sale' : 'customer_opening_receivable',
          referenceId: target.targetId,
          targetType: target.targetType,
          targetId: target.targetId,
          transactionGroupId,
        }),
      );
    }
    return effects;
  }

  private async insertLedgerEffect(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    posting: AccountingPeriodPostingContext,
    spec: {
      id: string;
      discriminator: string;
      entryType: 'credit_used' | 'refund' | 'settlement';
      receivableDeltaMinor: bigint;
      creditDeltaMinor: bigint;
      sourceSaleId: string | null;
      referenceType: string;
      referenceId: string;
      targetType: 'sale_receivable' | 'opening_receivable' | null;
      targetId: string | null;
      transactionGroupId: string;
    },
  ): Promise<CustomerFinancialLedgerEffect> {
    const operationId = deriveMoneyFactOperationId(command.operationId, spec.discriminator);
    const rows = await transaction
      .insert(customerLedgerEntries)
      .values({
        id: spec.id,
        storeId: context.storeId,
        customerId: command.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: spec.entryType,
        receivableDeltaMinor: spec.receivableDeltaMinor,
        creditDeltaMinor: spec.creditDeltaMinor,
        sourceSaleId: spec.sourceSaleId,
        referenceType: spec.referenceType,
        referenceId: spec.referenceId,
        transactionGroupId: spec.transactionGroupId,
        occurredAt: command.occurredAt,
        reason: command.reason,
        deviceId: context.deviceId,
        operationId,
      })
      .returning({ createdAt: customerLedgerEntries.createdAt });
    const row = rows[0];
    if (!row) throw new Error('Customer financial ledger insertion did not return a row.');
    return {
      id: spec.id,
      operationId,
      entryType: spec.entryType,
      receivableDeltaMinor: spec.receivableDeltaMinor.toString(),
      creditDeltaMinor: spec.creditDeltaMinor.toString(),
      targetType: spec.targetType,
      targetId: spec.targetId,
      reason: command.reason,
      occurredAt: command.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async lockMoneyAccount(
    transaction: DatabaseTransaction,
    storeId: string,
    accountId: string,
  ): Promise<void> {
    try {
      await this.moneyMovements.lockAndValidateAccounts(transaction, storeId, [accountId]);
    } catch (error) {
      if (error instanceof HttpException) {
        const response = error.getResponse();
        if (isRecord(response) && response.code === 'MONEY_ACCOUNT_NOT_FOUND') {
          reject('MONEY_ACCOUNT_NOT_FOUND');
        }
        if (isRecord(response) && response.code === 'MONEY_ACCOUNT_UNAVAILABLE') {
          reject('MONEY_ACCOUNT_UNAVAILABLE');
        }
      }
      throw error;
    }
  }

  private translatePlanningError(error: unknown): never {
    if (error instanceof CustomerReceivablePlanningError) reject(error.code);
    throw error;
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    postingDate: string,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        operationId: command.operationId,
        postingDate,
      });
    } catch (error) {
      if (error instanceof AccountingPeriodNotPostingEligibleError) {
        reject('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE');
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        reject('ACCOUNTING_PERIOD_INTEGRITY_CONFLICT');
      }
      throw error;
    }
  }

  private auditReason(command: CustomerFinancialCommand): string {
    if (command.action === 'apply_customer_credit') return 'Customer Credit applied';
    if (command.action === 'refund_customer_credit') return 'Customer Credit refunded';
    return 'Customer Receivable settled';
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
  ): Promise<CustomerFinancialResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (prior) return this.resolveProcessedOperation(transaction, context, command, prior);
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid, ${context.deviceId}::uuid,
            ${AGGREGATE}, ${command.operationId}::uuid, ${command.action}, ${command.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
      const concurrent = await this.readProcessedOperation(
        transaction,
        context.storeId,
        command.operationId,
      );
      if (!concurrent) throw error;
      return this.resolveProcessedOperation(transaction, context, command, concurrent);
    }
    if (claimed) return null;
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (!existing) throw new Error('Claimed Customer financial operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, command, existing);
  }

  private async readProcessedOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select device_id as "deviceId", aggregate_type as "aggregateType",
        aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
        response_code as "responseCode", response_body as "responseBody", error_code as "errorCode"
      from sync.processed_operations
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
    existing: ProcessedOperationRow,
  ): Promise<CustomerFinancialResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== AGGREGATE ||
      existing.aggregateId !== command.operationId ||
      existing.action !== command.action ||
      existing.requestHash !== command.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, command);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return { ok: true, response: parseStoredCustomerFinancialResponse(existing.responseBody) };
    }
    if (existing.status === 'rejected') return this.parseStoredRejection(existing);
    return failure('OPERATION_IN_PROGRESS');
  }

  private parseStoredRejection(existing: ProcessedOperationRow): FailureResult {
    const code = existing.errorCode;
    const body = existing.responseBody;
    if (
      !code ||
      !(code in definitions) ||
      !isRecord(body) ||
      body.code !== code ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Customer financial rejection is invalid.');
    }
    const definition = definitions[code as CustomerFinancialFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Customer financial rejection status is invalid.');
    }
    return { ok: false, error: { ...definition, message: body.message } };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: CustomerFinancialResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied', response_code=201, response_body=${JSON.stringify(response)}::jsonb,
        error_code=null, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Customer financial completion failed.');
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof CustomerFinancialRejectedError)) throw error;
    const response = { code: error.result.error.code, message: error.result.error.message };
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${error.result.error.statusCode},
        response_body=${JSON.stringify(response)}::jsonb, error_code=${error.result.error.code},
        completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Customer financial rejection failed.');
    return error.result;
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCommand,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts(
        store_id,operation_id,entity_type,entity_id,conflict_type,client_payload
      ) values(
        ${context.storeId}::uuid,${command.operationId}::uuid,${AGGREGATE},
        ${command.operationId}::uuid,'duplicate_identity',
        jsonb_build_object('action',${command.action}::text,'requestHash',${command.requestHash}::text)
      )
    `);
  }
}
