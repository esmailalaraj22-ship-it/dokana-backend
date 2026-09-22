import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { expensePayments, expenses, stores } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import { OwnerLedgerPostingRepository } from '../owner-ledger/owner-ledger-posting.repository';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';
import type { ExpensePaymentCommand } from './expense-payment-command';
import { parseStoredExpensePaymentResponse } from './expense-payment-response';
import type {
  ExpensePaymentFailure,
  ExpensePaymentFailureCode,
  ExpensePaymentPostingResponse,
  ExpensePaymentPostingResult,
} from './expense-payment.types';

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

interface LockedExpense {
  id: string;
  amountMinor: bigint;
  paymentTiming: 'paid_now' | 'due_later';
  status: 'draft' | 'posted' | 'cancelled';
}

interface SettlementRow extends Record<string, unknown> {
  recognizedAmountMinor: string;
  settledMinor: string;
  outstandingMinor: string;
}

interface Settlement {
  recognizedAmountMinor: bigint;
  settledMinor: bigint;
  outstandingMinor: bigint;
}

interface FailureResult {
  ok: false;
  error: ExpensePaymentFailure;
}

const failures: Readonly<Record<ExpensePaymentFailureCode, ExpensePaymentFailure>> = {
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
  EXPENSE_ALREADY_SETTLED: {
    code: 'EXPENSE_ALREADY_SETTLED',
    message: 'Expense has no outstanding amount to settle.',
    statusCode: 409,
  },
  EXPENSE_NOT_FOUND: {
    code: 'EXPENSE_NOT_FOUND',
    message: 'Expense not found.',
    statusCode: 404,
  },
  EXPENSE_NOT_SETTLEMENT_ELIGIBLE: {
    code: 'EXPENSE_NOT_SETTLEMENT_ELIGIBLE',
    message: 'Expense is not eligible for settlement.',
    statusCode: 409,
  },
  EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT: {
    code: 'EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT',
    message: 'Expense settlement facts are inconsistent.',
    statusCode: 409,
  },
  EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING: {
    code: 'EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING',
    message: 'Expense Payment exceeds the current outstanding amount.',
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

class ExpensePaymentRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'ExpensePaymentRejectedError';
  }
}

function failure(code: ExpensePaymentFailureCode): FailureResult {
  return { ok: false, error: failures[code] };
}

function reject(code: ExpensePaymentFailureCode): never {
  throw new ExpensePaymentRejectedError(failure(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ExpensePaymentRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly ownerLedger: OwnerLedgerPostingRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    command: ExpensePaymentCommand,
    postingDate: string,
  ): Promise<ExpensePaymentPostingResult> {
    const paymentId = deriveMoneyFactId(command.operationId, 'expense-payment');
    return this.database.withTenantTransaction(context, async (transaction) => {
      const replay = await this.beginMutation(transaction, context, command, paymentId);
      if (replay) return replay;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.insertWithinTransaction(savepoint, context, command, postingDate, paymentId),
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
    command: ExpensePaymentCommand,
    postingDate: string,
    paymentId: string,
  ): Promise<ExpensePaymentPostingResponse> {
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    const expense = await this.lockExpense(transaction, context.storeId, command.expenseId);
    const before = await this.readSettlement(transaction, context.storeId, command.expenseId);
    this.assertSettlementIntegrity(expense, before);
    if (before.outstandingMinor === 0n) reject('EXPENSE_ALREADY_SETTLED');
    if (command.amountMinor > before.outstandingMinor) {
      reject('EXPENSE_PAYMENT_EXCEEDS_OUTSTANDING');
    }
    if (command.paymentSource === 'money_account') {
      await this.lockMoneyAccount(transaction, context.storeId, command.moneyAccountId);
    }

    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    await transaction.execute(
      sql`select set_config('app.audit_reason', 'Expense Payment posted', true)`,
    );
    await transaction.insert(expensePayments).values({
      id: paymentId,
      storeId: context.storeId,
      expenseId: command.expenseId,
      accountingPeriodId: posting.accountingPeriodId,
      amountMinor: command.amountMinor,
      paymentSource: command.paymentSource,
      moneyAccountId: command.moneyAccountId,
      paymentAt: command.occurredAt,
      notes: command.notes,
      status: 'draft',
      deviceId: context.deviceId,
      operationId: command.operationId,
    });

    let moneyMovement: PostedMoneyMovement | null = null;
    let ownerLedgerEntry: PostedOwnerLedgerEntry | null = null;
    if (command.paymentSource === 'money_account') {
      if (command.moneyAccountId === null) throw new Error('Validated Money Account is missing.');
      moneyMovement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: 'expense-payment-money',
          accountId: command.moneyAccountId,
          amountDeltaMinor: -command.amountMinor,
          movementType: 'expense_payment',
          referenceType: 'expense_payment',
          referenceId: paymentId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          notes: command.notes,
        },
      );
    } else {
      ownerLedgerEntry = await this.ownerLedger.insertOwnerEntryWithinTransaction(
        transaction,
        context,
        {
          id: deriveMoneyFactId(command.operationId, 'expense-payment-owner'),
          operationId: deriveMoneyFactOperationId(command.operationId, 'expense-payment-owner'),
          entryType: 'owner_paid_expense',
          ownerLiabilityDeltaMinor: command.amountMinor,
          equityDeltaMinor: 0n,
          moneyAccountId: null,
          accountingPeriodId: posting.accountingPeriodId,
          transactionGroupId,
          occurredAt: command.occurredAt,
          referenceType: 'expense_payment',
          referenceId: paymentId,
        },
      );
    }

    const rows = await transaction
      .update(expensePayments)
      .set({
        status: 'posted',
        moneyMovementId: moneyMovement?.id ?? null,
        ownerLedgerEntryId: ownerLedgerEntry?.id ?? null,
      })
      .where(
        and(
          eq(expensePayments.storeId, context.storeId),
          eq(expensePayments.id, paymentId),
          eq(expensePayments.status, 'draft'),
        ),
      )
      .returning({
        amountMinor: expensePayments.amountMinor,
        paymentSource: expensePayments.paymentSource,
        moneyAccountId: expensePayments.moneyAccountId,
        moneyMovementId: expensePayments.moneyMovementId,
        ownerLedgerEntryId: expensePayments.ownerLedgerEntryId,
        paymentAt: expensePayments.paymentAt,
        notes: expensePayments.notes,
        status: expensePayments.status,
        operationId: expensePayments.operationId,
        version: expensePayments.version,
      });
    const payment = rows[0];
    if (payment?.status !== 'posted') {
      throw new Error('Expense Payment finalization did not return a posted row.');
    }

    const after = await this.readSettlement(transaction, context.storeId, command.expenseId);
    if (
      after.recognizedAmountMinor !== before.recognizedAmountMinor ||
      after.settledMinor !== before.settledMinor + command.amountMinor ||
      after.outstandingMinor !== before.outstandingMinor - command.amountMinor
    ) {
      reject('EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT');
    }

    return {
      operationId: command.operationId,
      expenseId: command.expenseId,
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      payment: {
        id: paymentId,
        amountMinor: payment.amountMinor.toString(),
        paymentSource: payment.paymentSource,
        moneyAccountId: payment.moneyAccountId,
        moneyMovementId: payment.moneyMovementId,
        ownerLedgerEntryId: payment.ownerLedgerEntryId,
        transactionGroupId,
        paymentAt: payment.paymentAt.toISOString(),
        notes: payment.notes,
        status: 'posted',
        operationId: payment.operationId,
        version: payment.version.toString(),
      },
      settlement: {
        recognizedAmountMinor: before.recognizedAmountMinor.toString(),
        settledBeforeMinor: before.settledMinor.toString(),
        settledAfterMinor: after.settledMinor.toString(),
        outstandingBeforeMinor: before.outstandingMinor.toString(),
        outstandingAfterMinor: after.outstandingMinor.toString(),
      },
      moneyMovement,
      ownerLedgerEntry,
    };
  }

  private async lockExpense(
    transaction: DatabaseTransaction,
    storeId: string,
    expenseId: string,
  ): Promise<LockedExpense> {
    const rows = await transaction
      .select({
        id: expenses.id,
        amountMinor: expenses.amountMinor,
        paymentTiming: expenses.paymentTiming,
        status: expenses.status,
      })
      .from(expenses)
      .where(and(eq(expenses.storeId, storeId), eq(expenses.id, expenseId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) reject('EXPENSE_NOT_FOUND');
    if (row.status !== 'posted' || row.paymentTiming !== 'due_later') {
      reject('EXPENSE_NOT_SETTLEMENT_ELIGIBLE');
    }
    return row;
  }

  private async readSettlement(
    transaction: DatabaseTransaction,
    storeId: string,
    expenseId: string,
  ): Promise<Settlement> {
    const result = await transaction.execute<SettlementRow>(sql`
      select amount_minor::text as "recognizedAmountMinor",
        paid_minor::text as "settledMinor", due_minor::text as "outstandingMinor"
      from ledger.v_expense_balances
      where store_id=${storeId}::uuid and expense_id=${expenseId}::uuid
    `);
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) reject('EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT');
    return {
      recognizedAmountMinor: BigInt(row.recognizedAmountMinor),
      settledMinor: BigInt(row.settledMinor),
      outstandingMinor: BigInt(row.outstandingMinor),
    };
  }

  private assertSettlementIntegrity(expense: LockedExpense, settlement: Settlement): void {
    if (
      settlement.recognizedAmountMinor !== expense.amountMinor ||
      settlement.settledMinor < 0n ||
      settlement.outstandingMinor < 0n ||
      settlement.settledMinor + settlement.outstandingMinor !== expense.amountMinor
    ) {
      reject('EXPENSE_OUTSTANDING_INTEGRITY_CONFLICT');
    }
  }

  private async lockMoneyAccount(
    transaction: DatabaseTransaction,
    storeId: string,
    moneyAccountId: string | null,
  ): Promise<void> {
    if (moneyAccountId === null) throw new Error('Money Account source is missing.');
    try {
      await this.moneyMovements.lockAndValidateAccounts(transaction, storeId, [moneyAccountId]);
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse();
        if (isRecord(body) && body.code === 'MONEY_ACCOUNT_NOT_FOUND') {
          reject('MONEY_ACCOUNT_NOT_FOUND');
        }
        if (isRecord(body) && body.code === 'MONEY_ACCOUNT_UNAVAILABLE') {
          reject('MONEY_ACCOUNT_UNAVAILABLE');
        }
      }
      throw error;
    }
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpensePaymentCommand,
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

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpensePaymentCommand,
    paymentId: string,
  ): Promise<ExpensePaymentPostingResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (prior)
      return this.resolveProcessedOperation(transaction, context, command, paymentId, prior);

    await this.assertActiveStore(transaction, context.storeId);
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'expense_payments', ${paymentId}::uuid,
            'expense_payments.post', ${command.requestHash}
          ) as claimed
        `),
      );
      if (result.rows[0]?.claimed === true) return null;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
    }
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (!existing) throw new Error('Claimed Expense Payment operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, command, paymentId, existing);
  }

  private async assertActiveStore(
    transaction: DatabaseTransaction,
    storeId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)
      .for('share');
    if (rows[0]?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  private async readProcessedOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select device_id as "deviceId", aggregate_type as "aggregateType",
        aggregate_id as "aggregateId", action, request_hash as "requestHash",
        status, response_code as "responseCode", response_body as "responseBody",
        error_code as "errorCode"
      from sync.processed_operations
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpensePaymentCommand,
    paymentId: string,
    existing: ProcessedOperationRow,
  ): Promise<ExpensePaymentPostingResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'expense_payments' ||
      existing.aggregateId !== paymentId ||
      existing.action !== 'expense_payments.post' ||
      existing.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts (
          store_id, operation_id, entity_type, entity_id,
          conflict_type, client_payload
        ) values (
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'expense_payments', ${paymentId}::uuid, 'duplicate_identity',
          jsonb_build_object('action', 'expense_payments.post', 'requestHash', ${command.requestHash}::text)
        )
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return { ok: true, response: parseStoredExpensePaymentResponse(existing.responseBody) };
    }
    if (existing.status === 'processing') return failure('OPERATION_IN_PROGRESS');
    return this.parseStoredRejection(existing);
  }

  private parseStoredRejection(existing: ProcessedOperationRow): FailureResult {
    const code = existing.errorCode;
    if (
      !code ||
      !(code in failures) ||
      !isRecord(existing.responseBody) ||
      existing.responseBody.code !== code ||
      typeof existing.responseBody.message !== 'string'
    ) {
      throw new Error('Stored Expense Payment rejection is invalid.');
    }
    const definition = failures[code as ExpensePaymentFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Expense Payment rejection status is invalid.');
    }
    return { ok: false, error: { ...definition, message: existing.responseBody.message } };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: ExpensePaymentPostingResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied', response_code=201,
        response_body=${JSON.stringify(response)}::jsonb, error_code=null,
        completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Expense Payment operation completion failed.');
    }
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof ExpensePaymentRejectedError)) throw error;
    const body = { code: error.result.error.code, message: error.result.error.message };
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${error.result.error.statusCode},
        response_body=${JSON.stringify(body)}::jsonb,
        error_code=${error.result.error.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Expense Payment rejection persistence failed.');
    }
    return error.result;
  }
}
