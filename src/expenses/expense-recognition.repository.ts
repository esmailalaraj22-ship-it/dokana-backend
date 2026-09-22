import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { expenseCategories, expensePayments, expenses, stores } from '../database/schema';
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
import type { ExpenseRecognitionCommand } from './expense-recognition-command';
import { parseStoredExpenseRecognitionResponse } from './expense-recognition-response';
import type {
  ExpenseRecognitionFailure,
  ExpenseRecognitionFailureCode,
  ExpenseRecognitionResponse,
  ExpenseRecognitionResult,
  PostedExpensePayment,
} from './expense-recognition.types';

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
  error: ExpenseRecognitionFailure;
}

const failures: Readonly<Record<ExpenseRecognitionFailureCode, ExpenseRecognitionFailure>> = {
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
  EXPENSE_CATEGORY_NOT_FOUND: {
    code: 'EXPENSE_CATEGORY_NOT_FOUND',
    message: 'Expense Category not found.',
    statusCode: 404,
  },
  EXPENSE_CATEGORY_UNAVAILABLE: {
    code: 'EXPENSE_CATEGORY_UNAVAILABLE',
    message: 'Expense Category is not available for new recognition.',
    statusCode: 409,
  },
  EXPENSE_ID_CONFLICT: {
    code: 'EXPENSE_ID_CONFLICT',
    message: 'Expense ID conflicts with an existing record.',
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

export class ExpenseRecognitionRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'ExpenseRecognitionRejectedError';
  }
}

function failure(code: ExpenseRecognitionFailureCode): FailureResult {
  return { ok: false, error: failures[code] };
}

function reject(code: ExpenseRecognitionFailureCode): never {
  throw new ExpenseRecognitionRejectedError(failure(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ExpenseRecognitionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly ownerLedger: OwnerLedgerPostingRepository,
  ) {}

  recognize(
    context: TenantTransactionContext,
    command: ExpenseRecognitionCommand,
    postingDate: string,
  ): Promise<ExpenseRecognitionResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const replay = await this.beginMutation(transaction, context, command);
      if (replay) return replay;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.insertRecognitionWithinTransaction(savepoint, context, command, postingDate),
        );
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  async insertRecognitionWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCommand,
    postingDate: string,
  ): Promise<ExpenseRecognitionResponse> {
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    await this.lockCategory(transaction, context.storeId, command.categoryId);
    if (command.mode === 'MONEY_PAID') {
      if (command.moneyAccountId === null) throw new Error('Validated Money Account is missing.');
      await this.lockMoneyAccount(transaction, context.storeId, command.moneyAccountId);
    }

    await transaction.execute(
      sql`select set_config('app.audit_reason', 'Expense recognized', true)`,
    );
    try {
      await transaction.insert(expenses).values({
        id: command.expenseId,
        storeId: context.storeId,
        categoryId: command.categoryId,
        accountingPeriodId: posting.accountingPeriodId,
        description: command.description,
        amountMinor: command.amountMinor,
        paidTotalMinor: command.mode === 'DUE' ? 0n : command.amountMinor,
        expenseAt: command.occurredAt,
        dueAt: command.dueAt,
        paymentTiming: command.mode === 'DUE' ? 'due_later' : 'paid_now',
        status: 'draft',
        notes: command.notes,
        deviceId: context.deviceId,
        operationId: command.operationId,
      });
    } catch (error) {
      const code = postgresqlErrorCode(error);
      if (code === '23505') reject('EXPENSE_ID_CONFLICT');
      throw error;
    }

    let payment: PostedExpensePayment | null = null;
    let moneyMovement: PostedMoneyMovement | null = null;
    let ownerLedgerEntry: PostedOwnerLedgerEntry | null = null;
    if (command.mode !== 'DUE') {
      const paymentId = deriveMoneyFactId(command.operationId, 'expense-payment');
      const paymentOperationId = deriveMoneyFactOperationId(command.operationId, 'expense-payment');
      await transaction.insert(expensePayments).values({
        id: paymentId,
        storeId: context.storeId,
        expenseId: command.expenseId,
        accountingPeriodId: posting.accountingPeriodId,
        amountMinor: command.amountMinor,
        paymentSource: command.mode === 'MONEY_PAID' ? 'money_account' : 'owner_pocket',
        moneyAccountId: command.moneyAccountId,
        paymentAt: command.occurredAt,
        notes: command.notes,
        status: 'draft',
        deviceId: context.deviceId,
        operationId: paymentOperationId,
      });

      const transactionGroupId = deriveTransactionGroupId(command.operationId);
      if (command.mode === 'MONEY_PAID') {
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

      const paymentRows = await transaction
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
          id: expensePayments.id,
          amountMinor: expensePayments.amountMinor,
          paymentSource: expensePayments.paymentSource,
          moneyAccountId: expensePayments.moneyAccountId,
          moneyMovementId: expensePayments.moneyMovementId,
          ownerLedgerEntryId: expensePayments.ownerLedgerEntryId,
          paymentAt: expensePayments.paymentAt,
          status: expensePayments.status,
          operationId: expensePayments.operationId,
          version: expensePayments.version,
        });
      const row = paymentRows[0];
      if (row?.status !== 'posted') {
        throw new Error('Expense Payment finalization did not return a posted row.');
      }
      payment = {
        id: row.id,
        amountMinor: row.amountMinor.toString(),
        paymentSource: row.paymentSource,
        moneyAccountId: row.moneyAccountId,
        moneyMovementId: row.moneyMovementId,
        ownerLedgerEntryId: row.ownerLedgerEntryId,
        paymentAt: row.paymentAt.toISOString(),
        status: row.status,
        operationId: row.operationId,
        version: row.version.toString(),
      };
    }

    const expenseRows = await transaction
      .update(expenses)
      .set({ status: 'posted' })
      .where(
        and(
          eq(expenses.storeId, context.storeId),
          eq(expenses.id, command.expenseId),
          eq(expenses.status, 'draft'),
        ),
      )
      .returning({ version: expenses.version });
    const finalized = expenseRows[0];
    if (!finalized) throw new Error('Expense finalization did not return a row.');

    const outstanding = await transaction.execute<{ dueMinor: string }>(sql`
      select due_minor::text as "dueMinor"
      from ledger.v_expense_balances
      where store_id=${context.storeId}::uuid and expense_id=${command.expenseId}::uuid
    `);
    const dueMinor = outstanding.rows[0]?.dueMinor;
    if (dueMinor === undefined) throw new Error('Expense outstanding projection is unavailable.');

    return {
      operationId: command.operationId,
      mode: command.mode,
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      expense: {
        id: command.expenseId,
        categoryId: command.categoryId,
        description: command.description,
        amountMinor: command.amountMinor.toString(),
        paidTotalMinor: command.mode === 'DUE' ? '0' : command.amountMinor.toString(),
        outstandingMinor: dueMinor,
        expenseAt: command.occurredAt.toISOString(),
        dueAt: command.dueAt?.toISOString() ?? null,
        paymentTiming: command.mode === 'DUE' ? 'due_later' : 'paid_now',
        status: 'posted',
        notes: command.notes,
        version: finalized.version.toString(),
      },
      payment,
      moneyMovement,
      ownerLedgerEntry,
    };
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCommand,
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

  private async lockCategory(
    transaction: DatabaseTransaction,
    storeId: string,
    categoryId: string | null,
  ): Promise<void> {
    if (categoryId === null) return;
    const rows = await transaction
      .select({ status: expenseCategories.status })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.storeId, storeId), eq(expenseCategories.id, categoryId)))
      .limit(1)
      .for('share');
    if (!rows[0]) reject('EXPENSE_CATEGORY_NOT_FOUND');
    if (rows[0].status !== 'active') reject('EXPENSE_CATEGORY_UNAVAILABLE');
  }

  private async lockMoneyAccount(
    transaction: DatabaseTransaction,
    storeId: string,
    moneyAccountId: string,
  ): Promise<void> {
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

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCommand,
  ): Promise<ExpenseRecognitionResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (prior) return this.resolveProcessedOperation(transaction, context, command, prior);

    await this.assertActiveStore(transaction, context.storeId);
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'expenses', ${command.expenseId}::uuid,
            'expenses.recognize', ${command.requestHash}
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
    if (!existing) throw new Error('Claimed Expense operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, command, existing);
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
    command: ExpenseRecognitionCommand,
    existing: ProcessedOperationRow,
  ): Promise<ExpenseRecognitionResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'expenses' ||
      existing.aggregateId !== command.expenseId ||
      existing.action !== 'expenses.recognize' ||
      existing.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts (
          store_id, operation_id, entity_type, entity_id,
          conflict_type, client_payload
        ) values (
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'expenses', ${command.expenseId}::uuid, 'duplicate_identity',
          jsonb_build_object('action', 'expenses.recognize', 'requestHash', ${command.requestHash}::text)
        )
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return { ok: true, response: parseStoredExpenseRecognitionResponse(existing.responseBody) };
    }
    if (existing.status === 'processing') return failure('OPERATION_IN_PROGRESS');
    const code = existing.errorCode;
    if (
      !code ||
      !(code in failures) ||
      !isRecord(existing.responseBody) ||
      existing.responseBody.code !== code ||
      typeof existing.responseBody.message !== 'string'
    ) {
      throw new Error('Stored Expense recognition rejection is invalid.');
    }
    const definition = failures[code as ExpenseRecognitionFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Expense recognition rejection status is invalid.');
    }
    return { ok: false, error: { ...definition, message: existing.responseBody.message } };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: ExpenseRecognitionResponse,
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
    if (completed.rows.length !== 1) throw new Error('Expense operation completion failed.');
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof ExpenseRecognitionRejectedError)) throw error;
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
    if (completed.rows.length !== 1) throw new Error('Expense rejection persistence failed.');
    return error.result;
  }
}
