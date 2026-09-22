import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  expensePayments,
  expenses,
  moneyAccounts,
  moneyMovements,
  ownerLedgerEntries,
  stores,
} from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import { OwnerLedgerPostingRepository } from '../owner-ledger/owner-ledger-posting.repository';
import type {
  ExpensePaymentCorrectionCommand,
  ExpenseRecognitionCorrectionCommand,
} from './expense-correction-command';
import { parseStoredExpenseCorrectionResponse } from './expense-correction-response';
import type {
  ExpenseCorrectionFailure,
  ExpenseCorrectionFailureCode,
  ExpenseCorrectionResponse,
  ExpenseCorrectionResult,
  ExpenseMoneyReversal,
  ExpenseOwnerReversal,
  ExpensePaymentCorrectionResponse,
  ExpenseRecognitionCorrectionResponse,
} from './expense-correction.types';
import {
  ExpensePaymentRejectedError,
  ExpensePaymentRepository,
} from './expense-payment.repository';
import {
  ExpenseRecognitionRejectedError,
  ExpenseRecognitionRepository,
} from './expense-recognition.repository';

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

interface ExpenseDescriptor {
  expenseId: string;
}

interface PaymentDescriptor {
  paymentId: string;
}

interface ExpenseTargetRow extends Record<string, unknown> {
  expenseId: string;
  operationId: string;
  accountingPeriodId: string | null;
  amountMinor: string;
  paidTotalMinor: string;
  paymentTiming: 'paid_now' | 'due_later';
  status: 'draft' | 'posted' | 'cancelled';
  cancelledAt: Date | null;
}

interface PaymentTargetRow extends Record<string, unknown> {
  paymentId: string;
  expenseId: string;
  paymentOperationId: string;
  accountingPeriodId: string | null;
  amountMinor: string;
  paymentSource: 'money_account' | 'owner_pocket';
  moneyAccountId: string | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  status: 'draft' | 'posted' | 'cancelled';
  cancelledAt: Date | null;
}

interface MoneyFundingRow {
  kind: 'money';
  id: string;
  accountId: string;
  accountingPeriodId: string;
  amountDeltaMinor: bigint;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  reversalOfId: string | null;
  operationId: string;
}

interface OwnerFundingRow {
  kind: 'owner';
  id: string;
  accountingPeriodId: string;
  ownerLiabilityDeltaMinor: bigint;
  equityDeltaMinor: bigint;
  moneyAccountId: string | null;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  reversalOfId: string | null;
  operationId: string;
}

type FundingRow = MoneyFundingRow | OwnerFundingRow;

const failures: Readonly<Record<ExpenseCorrectionFailureCode, ExpenseCorrectionFailure>> = {
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
  EXPENSE_CORRECTION_ACTIVE_PAYMENT_DEPENDENCY: {
    code: 'EXPENSE_CORRECTION_ACTIVE_PAYMENT_DEPENDENCY',
    message: 'Expense has active later Payments that must be corrected first.',
    statusCode: 409,
  },
  EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Expense correction target is inconsistent.',
    statusCode: 409,
  },
  EXPENSE_CORRECTION_TARGET_NOT_ACTIVE: {
    code: 'EXPENSE_CORRECTION_TARGET_NOT_ACTIVE',
    message: 'Expense correction target is not the active operation.',
    statusCode: 409,
  },
  EXPENSE_CORRECTION_TARGET_NOT_FOUND: {
    code: 'EXPENSE_CORRECTION_TARGET_NOT_FOUND',
    message: 'Expense correction target not found.',
    statusCode: 404,
  },
  EXPENSE_ID_CONFLICT: {
    code: 'EXPENSE_ID_CONFLICT',
    message: 'Expense ID conflicts with an existing record.',
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
  EXPENSE_PAYMENT_CORRECTION_TARGET_EXPENSE_MISMATCH: {
    code: 'EXPENSE_PAYMENT_CORRECTION_TARGET_EXPENSE_MISMATCH',
    message: 'Replacement Expense must match the corrected Expense Payment.',
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

class ExpenseCorrectionRejectedError extends Error {
  constructor(readonly error: ExpenseCorrectionFailure) {
    super(error.message);
    this.name = 'ExpenseCorrectionRejectedError';
  }
}

function reject(code: ExpenseCorrectionFailureCode): never {
  throw new ExpenseCorrectionRejectedError(failures[code]);
}

function failure(code: ExpenseCorrectionFailureCode): ExpenseCorrectionResult {
  return { ok: false, error: failures[code] };
}

@Injectable()
export class ExpenseCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly recognition: ExpenseRecognitionRepository,
    private readonly payments: ExpensePaymentRepository,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly ownerLedger: OwnerLedgerPostingRepository,
  ) {}

  correctExpense(
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<ExpenseCorrectionResult> {
    return this.correct(context, command, postingDate, replacementPostingDate);
  }

  correctPayment(
    context: TenantTransactionContext,
    command: ExpensePaymentCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<ExpenseCorrectionResult> {
    return this.correct(context, command, postingDate, replacementPostingDate);
  }

  private correct(
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand | ExpensePaymentCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<ExpenseCorrectionResult> {
    const action = this.action(command);
    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readOperation(transaction, context.storeId, command.operationId);
      if (prior) return this.replay(transaction, context, command, action, prior);
      await this.lockActiveStore(transaction, context.storeId);
      const claimed = await this.claimOperation(transaction, context, command, action);
      if (claimed) return claimed;

      try {
        let response: ExpenseCorrectionResponse;
        if (command.aggregate === 'expense') {
          response = await transaction.transaction((savepoint) =>
            this.applyExpenseCorrection(
              savepoint,
              context,
              command,
              postingDate,
              replacementPostingDate,
            ),
          );
        } else {
          response = await transaction.transaction((savepoint) =>
            this.applyPaymentCorrection(
              savepoint,
              context,
              command,
              postingDate,
              replacementPostingDate,
            ),
          );
        }
        await this.completeApplied(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        const known = this.knownFailure(error);
        if (!known) throw error;
        await this.completeRejected(transaction, context.storeId, command.operationId, known);
        return { ok: false, error: known };
      }
    });
  }

  private async applyExpenseCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<ExpenseRecognitionCorrectionResponse> {
    const operation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const descriptor = this.resolveExpenseTarget(operation, command.targetOperationId);
    const target = await this.lockExpenseTarget(
      transaction,
      context.storeId,
      descriptor.expenseId,
      command.targetOperationId,
    );
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId, [
      'expenses.cancel',
      'expenses.edit',
    ]);

    const internalPaymentOperationId = deriveMoneyFactOperationId(
      command.targetOperationId,
      'expense-payment',
    );
    const internalPayment = await this.lockInternalPayment(
      transaction,
      context.storeId,
      target.expenseId,
      internalPaymentOperationId,
    );
    this.assertExpenseTargetIntegrity(target, internalPayment);
    await this.assertNoActiveLaterPayments(
      transaction,
      context.storeId,
      target.expenseId,
      internalPaymentOperationId,
    );
    const posting = await this.resolvePosting(
      transaction,
      context,
      command.operationId,
      postingDate,
    );
    await this.lockAffectedAccounts(
      transaction,
      context.storeId,
      internalPayment?.moneyAccountId ?? null,
      command.kind === 'edit' ? command.replacement.moneyAccountId : null,
    );
    const funding =
      internalPayment === null
        ? null
        : await this.loadFundingFact(
            transaction,
            context.storeId,
            internalPayment,
            command.targetOperationId,
          );

    await transaction.execute(sql`select set_config('app.audit_reason', ${command.reason}, true)`);
    const reversal = await this.reverseExpenseFunding(
      transaction,
      context,
      command,
      posting,
      target,
      internalPayment,
      funding,
    );
    if (internalPayment !== null) {
      const cancelledPayment = await transaction
        .update(expensePayments)
        .set({ status: 'cancelled', cancelledAt: command.occurredAt })
        .where(
          and(
            eq(expensePayments.storeId, context.storeId),
            eq(expensePayments.id, internalPayment.paymentId),
            eq(expensePayments.status, 'posted'),
          ),
        )
        .returning({ id: expensePayments.id });
      if (!cancelledPayment[0]) reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    }
    const cancelled = await transaction
      .update(expenses)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(expenses.storeId, context.storeId),
          eq(expenses.id, target.expenseId),
          eq(expenses.status, 'posted'),
        ),
      )
      .returning({ version: expenses.version });
    const cancelledRow = cancelled[0];
    if (!cancelledRow) reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');

    const replacement =
      command.kind === 'edit'
        ? await this.recognition.insertRecognitionWithinTransaction(
            transaction,
            context,
            command.replacement,
            this.requireReplacementPostingDate(replacementPostingDate),
          )
        : null;

    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      aggregate: 'expense',
      intent: command.kind,
      reason: command.reason,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      target: {
        expenseId: target.expenseId,
        status: 'cancelled',
        cancelledAt: command.occurredAt.toISOString(),
        version: cancelledRow.version.toString(),
      },
      reversal,
      replacement,
    };
  }

  private async applyPaymentCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpensePaymentCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<ExpensePaymentCorrectionResponse> {
    const operation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const descriptor = this.resolvePaymentTarget(operation, command.targetOperationId);
    const expenseId = await this.readPaymentExpenseId(
      transaction,
      context.storeId,
      descriptor.paymentId,
      command.targetOperationId,
    );
    await this.lockSettlementExpense(transaction, context.storeId, expenseId);
    const target = await this.lockPaymentTarget(
      transaction,
      context.storeId,
      descriptor.paymentId,
      command.targetOperationId,
    );
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId, [
      'expense_payments.cancel',
      'expense_payments.edit',
    ]);
    if (command.kind === 'edit' && command.replacement.expenseId !== target.expenseId) {
      reject('EXPENSE_PAYMENT_CORRECTION_TARGET_EXPENSE_MISMATCH');
    }
    const posting = await this.resolvePosting(
      transaction,
      context,
      command.operationId,
      postingDate,
    );
    await this.lockAffectedAccounts(
      transaction,
      context.storeId,
      target.moneyAccountId,
      command.kind === 'edit' ? command.replacement.moneyAccountId : null,
    );
    const funding = await this.loadFundingFact(
      transaction,
      context.storeId,
      target,
      target.paymentOperationId,
    );

    await transaction.execute(sql`select set_config('app.audit_reason', ${command.reason}, true)`);
    const reversal = await this.reversePaymentFunding(
      transaction,
      context,
      command,
      posting,
      target,
      funding,
    );
    const cancelled = await transaction
      .update(expensePayments)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(expensePayments.storeId, context.storeId),
          eq(expensePayments.id, target.paymentId),
          eq(expensePayments.status, 'posted'),
        ),
      )
      .returning({ version: expensePayments.version });
    const cancelledRow = cancelled[0];
    if (!cancelledRow) reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');

    const replacement =
      command.kind === 'edit'
        ? await this.payments.insertPaymentWithinTransaction(
            transaction,
            context,
            command.replacement,
            this.requireReplacementPostingDate(replacementPostingDate),
          )
        : null;

    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      aggregate: 'expense_payment',
      intent: command.kind,
      reason: command.reason,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      target: {
        expenseId: target.expenseId,
        paymentId: target.paymentId,
        status: 'cancelled',
        cancelledAt: command.occurredAt.toISOString(),
        version: cancelledRow.version.toString(),
      },
      reversal,
      replacement,
    };
  }

  private resolveExpenseTarget(
    row: ProcessedOperationRow | undefined,
    targetOperationId: string,
  ): ExpenseDescriptor {
    if (!row) reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    if (row.responseCode !== 201) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (row.action === 'expenses.recognize' && row.aggregateType === 'expenses') {
      return { expenseId: row.aggregateId };
    }
    if (row.action === 'expenses.edit' && row.aggregateType === 'expense_corrections') {
      const response = this.parseTargetResponse(row.responseBody);
      if (
        response.aggregate !== 'expense' ||
        response.intent !== 'edit' ||
        response.operationId !== targetOperationId ||
        response.replacement === null
      ) {
        reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { expenseId: response.replacement.expense.id };
    }
    if (row.action === 'expenses.cancel') reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
  }

  private resolvePaymentTarget(
    row: ProcessedOperationRow | undefined,
    targetOperationId: string,
  ): PaymentDescriptor {
    if (!row) reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    if (row.responseCode !== 201) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (row.action === 'expense_payments.post' && row.aggregateType === 'expense_payments') {
      const expected = deriveMoneyFactId(targetOperationId, 'expense-payment');
      if (row.aggregateId !== expected) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      return { paymentId: expected };
    }
    if (row.action === 'expense_payments.edit' && row.aggregateType === 'expense_corrections') {
      const response = this.parseTargetResponse(row.responseBody);
      if (
        response.aggregate !== 'expense_payment' ||
        response.intent !== 'edit' ||
        response.operationId !== targetOperationId ||
        response.replacement === null
      ) {
        reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { paymentId: response.replacement.payment.id };
    }
    if (row.action === 'expense_payments.cancel') reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
  }

  private parseTargetResponse(value: unknown): ExpenseCorrectionResponse {
    try {
      return parseStoredExpenseCorrectionResponse(value);
    } catch {
      reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async lockExpenseTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    expenseId: string,
    operationId: string,
  ): Promise<ExpenseTargetRow> {
    const result = await transaction.execute<ExpenseTargetRow>(sql`
      select id as "expenseId", operation_id as "operationId",
        accounting_period_id as "accountingPeriodId", amount_minor::text as "amountMinor",
        paid_total_minor::text as "paidTotalMinor", payment_timing as "paymentTiming",
        status, cancelled_at as "cancelledAt"
      from ledger.expenses
      where store_id=${storeId}::uuid and id=${expenseId}::uuid
        and operation_id=${operationId}::uuid
      for update
    `);
    const row = result.rows[0];
    if (!row) reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
    if (result.rows.length !== 1) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (row.status !== 'posted') reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    return row;
  }

  private async lockInternalPayment(
    transaction: DatabaseTransaction,
    storeId: string,
    expenseId: string,
    operationId: string,
  ): Promise<PaymentTargetRow | null> {
    const result = await transaction.execute<PaymentTargetRow>(sql`
      select id as "paymentId", expense_id as "expenseId",
        operation_id as "paymentOperationId", accounting_period_id as "accountingPeriodId",
        amount_minor::text as "amountMinor", payment_source as "paymentSource",
        money_account_id as "moneyAccountId", money_movement_id as "moneyMovementId",
        owner_ledger_entry_id as "ownerLedgerEntryId", status,
        cancelled_at as "cancelledAt"
      from ledger.expense_payments
      where store_id=${storeId}::uuid and expense_id=${expenseId}::uuid
        and operation_id=${operationId}::uuid
      for update
    `);
    if (result.rows.length > 1) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    return result.rows[0] ?? null;
  }

  private assertExpenseTargetIntegrity(
    target: ExpenseTargetRow,
    internalPayment: PaymentTargetRow | null,
  ): void {
    const amount = BigInt(target.amountMinor);
    const commonInvalid =
      amount <= 0n || target.accountingPeriodId === null || target.cancelledAt !== null;
    const dueInvalid =
      target.paymentTiming === 'due_later' &&
      (target.paidTotalMinor !== '0' || internalPayment !== null);
    const paidInvalid =
      target.paymentTiming === 'paid_now' &&
      (target.paidTotalMinor !== target.amountMinor ||
        internalPayment?.status !== 'posted' ||
        internalPayment.cancelledAt !== null ||
        internalPayment.accountingPeriodId !== target.accountingPeriodId ||
        internalPayment.amountMinor !== target.amountMinor);
    if (commonInvalid || dueInvalid || paidInvalid) {
      reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async assertNoActiveLaterPayments(
    transaction: DatabaseTransaction,
    storeId: string,
    expenseId: string,
    internalOperationId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ count: string }>(sql`
      select count(*)::text as count
      from ledger.expense_payments
      where store_id=${storeId}::uuid and expense_id=${expenseId}::uuid
        and status='posted' and operation_id<>${internalOperationId}::uuid
    `);
    if (result.rows[0]?.count !== '0') {
      reject('EXPENSE_CORRECTION_ACTIVE_PAYMENT_DEPENDENCY');
    }
  }

  private async readPaymentExpenseId(
    transaction: DatabaseTransaction,
    storeId: string,
    paymentId: string,
    operationId: string,
  ): Promise<string> {
    const rows = await transaction
      .select({ expenseId: expensePayments.expenseId })
      .from(expensePayments)
      .where(
        and(
          eq(expensePayments.storeId, storeId),
          eq(expensePayments.id, paymentId),
          eq(expensePayments.operationId, operationId),
        ),
      )
      .limit(1);
    if (!rows[0]) reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
    return rows[0].expenseId;
  }

  private async lockSettlementExpense(
    transaction: DatabaseTransaction,
    storeId: string,
    expenseId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: expenses.status, paymentTiming: expenses.paymentTiming })
      .from(expenses)
      .where(and(eq(expenses.storeId, storeId), eq(expenses.id, expenseId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'posted' || row.paymentTiming !== 'due_later') {
      reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    }
  }

  private async lockPaymentTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    paymentId: string,
    operationId: string,
  ): Promise<PaymentTargetRow> {
    const result = await transaction.execute<PaymentTargetRow>(sql`
      select id as "paymentId", expense_id as "expenseId",
        operation_id as "paymentOperationId", accounting_period_id as "accountingPeriodId",
        amount_minor::text as "amountMinor", payment_source as "paymentSource",
        money_account_id as "moneyAccountId", money_movement_id as "moneyMovementId",
        owner_ledger_entry_id as "ownerLedgerEntryId", status,
        cancelled_at as "cancelledAt"
      from ledger.expense_payments
      where store_id=${storeId}::uuid and id=${paymentId}::uuid
        and operation_id=${operationId}::uuid
      for update
    `);
    const row = result.rows[0];
    if (!row) reject('EXPENSE_CORRECTION_TARGET_NOT_FOUND');
    if (result.rows.length !== 1) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    if (
      row.status !== 'posted' ||
      row.cancelledAt !== null ||
      row.accountingPeriodId === null ||
      BigInt(row.amountMinor) <= 0n
    ) {
      reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
    }
    return row;
  }

  private async lockAffectedAccounts(
    transaction: DatabaseTransaction,
    storeId: string,
    historicalAccountId: string | null,
    replacementAccountId: string | null,
  ): Promise<void> {
    const ids = [historicalAccountId, replacementAccountId]
      .filter((id): id is string => id !== null)
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort();
    for (const id of ids) {
      await transaction
        .select({ id: moneyAccounts.id })
        .from(moneyAccounts)
        .where(and(eq(moneyAccounts.storeId, storeId), eq(moneyAccounts.id, id)))
        .limit(1)
        .for('update');
    }
  }

  private async loadFundingFact(
    transaction: DatabaseTransaction,
    storeId: string,
    payment: PaymentTargetRow,
    rootOperationId: string,
  ): Promise<FundingRow> {
    const amount = BigInt(payment.amountMinor);
    const expectedGroup = deriveTransactionGroupId(rootOperationId);
    if (payment.paymentSource === 'money_account') {
      if (
        payment.moneyAccountId === null ||
        payment.moneyMovementId === null ||
        payment.ownerLedgerEntryId !== null
      ) {
        reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const rows = await transaction
        .select({
          id: moneyMovements.id,
          accountId: moneyMovements.accountId,
          accountingPeriodId: moneyMovements.accountingPeriodId,
          amountDeltaMinor: moneyMovements.amountDeltaMinor,
          movementType: moneyMovements.movementType,
          referenceType: moneyMovements.referenceType,
          referenceId: moneyMovements.referenceId,
          transactionGroupId: moneyMovements.transactionGroupId,
          reversalOfId: moneyMovements.reversalOfId,
          operationId: moneyMovements.operationId,
        })
        .from(moneyMovements)
        .where(
          and(eq(moneyMovements.storeId, storeId), eq(moneyMovements.id, payment.moneyMovementId)),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      const reversalCount = await this.countMoneyReversals(transaction, storeId, row.id);
      if (
        row.accountId !== payment.moneyAccountId ||
        row.accountingPeriodId !== payment.accountingPeriodId ||
        row.movementType !== 'expense_payment' ||
        row.amountDeltaMinor !== -amount ||
        row.referenceType !== 'expense_payment' ||
        row.referenceId !== payment.paymentId ||
        row.transactionGroupId !== expectedGroup ||
        row.reversalOfId !== null ||
        row.operationId !== deriveMoneyFactOperationId(rootOperationId, 'expense-payment-money') ||
        reversalCount !== '0'
      ) {
        reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { kind: 'money', ...row };
    }

    if (
      payment.moneyAccountId !== null ||
      payment.moneyMovementId !== null ||
      payment.ownerLedgerEntryId === null
    ) {
      reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const rows = await transaction
      .select({
        id: ownerLedgerEntries.id,
        accountingPeriodId: ownerLedgerEntries.accountingPeriodId,
        ownerLiabilityDeltaMinor: ownerLedgerEntries.ownerLiabilityDeltaMinor,
        equityDeltaMinor: ownerLedgerEntries.equityDeltaMinor,
        entryType: ownerLedgerEntries.entryType,
        moneyAccountId: ownerLedgerEntries.moneyAccountId,
        referenceType: ownerLedgerEntries.referenceType,
        referenceId: ownerLedgerEntries.referenceId,
        transactionGroupId: ownerLedgerEntries.transactionGroupId,
        reversalOfId: ownerLedgerEntries.reversalOfId,
        operationId: ownerLedgerEntries.operationId,
      })
      .from(ownerLedgerEntries)
      .where(
        and(
          eq(ownerLedgerEntries.storeId, storeId),
          eq(ownerLedgerEntries.id, payment.ownerLedgerEntryId),
        ),
      )
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    const reversalCount = await this.countOwnerReversals(transaction, storeId, row.id);
    if (
      row.accountingPeriodId !== payment.accountingPeriodId ||
      row.entryType !== 'owner_paid_expense' ||
      row.ownerLiabilityDeltaMinor !== amount ||
      row.equityDeltaMinor !== 0n ||
      row.moneyAccountId !== null ||
      row.referenceType === null ||
      row.referenceId === null ||
      row.referenceType !== 'expense_payment' ||
      row.referenceId !== payment.paymentId ||
      row.transactionGroupId !== expectedGroup ||
      row.reversalOfId !== null ||
      row.operationId !== deriveMoneyFactOperationId(rootOperationId, 'expense-payment-owner') ||
      reversalCount !== '0'
    ) {
      reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      kind: 'owner',
      id: row.id,
      accountingPeriodId: row.accountingPeriodId,
      ownerLiabilityDeltaMinor: row.ownerLiabilityDeltaMinor,
      equityDeltaMinor: row.equityDeltaMinor,
      moneyAccountId: row.moneyAccountId,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      transactionGroupId: row.transactionGroupId,
      reversalOfId: row.reversalOfId,
      operationId: row.operationId,
    };
  }

  private async reverseExpenseFunding(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: ExpenseTargetRow,
    payment: PaymentTargetRow | null,
    funding: FundingRow | null,
  ): Promise<ExpenseRecognitionCorrectionResponse['reversal']> {
    const financial = await this.insertFundingReversal(
      transaction,
      context,
      command.operationId,
      command.occurredAt,
      command.reason,
      posting,
      target.expenseId,
      payment,
      funding,
      'expense_correction',
    );
    return {
      originalAmountMinor: target.amountMinor,
      amountDeltaMinor: (-BigInt(target.amountMinor)).toString(),
      internalPaymentId: payment?.paymentId ?? null,
      ...financial,
    };
  }

  private async reversePaymentFunding(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpensePaymentCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: PaymentTargetRow,
    funding: FundingRow,
  ): Promise<ExpensePaymentCorrectionResponse['reversal']> {
    const financial = await this.insertFundingReversal(
      transaction,
      context,
      command.operationId,
      command.occurredAt,
      command.reason,
      posting,
      target.paymentId,
      target,
      funding,
      'expense_payment_correction',
    );
    return { expenseRecognitionDeltaMinor: '0', ...financial };
  }

  private async insertFundingReversal(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operationId: string,
    occurredAt: Date,
    reason: string,
    posting: AccountingPeriodPostingContext,
    referenceId: string,
    payment: PaymentTargetRow | null,
    funding: FundingRow | null,
    referenceType: string,
  ): Promise<{
    moneyMovement: ExpenseMoneyReversal | null;
    ownerLedgerEntry: ExpenseOwnerReversal | null;
  }> {
    if (payment === null && funding === null) {
      return { moneyMovement: null, ownerLedgerEntry: null };
    }
    if (payment === null || funding === null) {
      reject('EXPENSE_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const transactionGroupId = deriveTransactionGroupId(operationId);
    if (funding.kind === 'money') {
      const movement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: operationId,
          discriminator: `${referenceType}-money-reversal`,
          accountId: funding.accountId,
          amountDeltaMinor: -funding.amountDeltaMinor,
          movementType: 'correction',
          referenceType,
          referenceId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt,
          transactionGroupId,
          notes: reason,
          reversalOfId: funding.id,
        },
      );
      return {
        moneyMovement: { ...movement, movementType: 'correction', reversalOfId: funding.id },
        ownerLedgerEntry: null,
      };
    }
    const entry = await this.ownerLedger.insertOwnerEntryWithinTransaction(transaction, context, {
      id: deriveMoneyFactId(operationId, `${referenceType}-owner-reversal`),
      operationId: deriveMoneyFactOperationId(operationId, `${referenceType}-owner-reversal`),
      entryType: 'correction',
      ownerLiabilityDeltaMinor: -funding.ownerLiabilityDeltaMinor,
      equityDeltaMinor: -funding.equityDeltaMinor,
      moneyAccountId: funding.moneyAccountId,
      accountingPeriodId: posting.accountingPeriodId,
      transactionGroupId,
      occurredAt,
      referenceType,
      referenceId,
      reversalOfId: funding.id,
    });
    return {
      moneyMovement: null,
      ownerLedgerEntry: { ...entry, entryType: 'correction', reversalOfId: funding.id },
    };
  }

  private async countMoneyReversals(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<string> {
    const result = await transaction.execute<{ count: string }>(sql`
      select count(*)::text as count from ledger.money_movements
      where store_id=${storeId}::uuid and reversal_of_id=${id}::uuid
    `);
    return result.rows[0]?.count ?? '0';
  }

  private async countOwnerReversals(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<string> {
    const result = await transaction.execute<{ count: string }>(sql`
      select count(*)::text as count from ledger.owner_ledger_entries
      where store_id=${storeId}::uuid and reversal_of_id=${id}::uuid
    `);
    return result.rows[0]?.count ?? '0';
  }

  private async assertTargetIsActive(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    actions: string[],
  ): Promise<void> {
    const result = await transaction.execute<{ superseded: boolean }>(sql`
      select exists (
        select 1 from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied'
          and action in (${actions[0]}, ${actions[1]})
          and response_body ->> 'targetOperationId'=${operationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded) reject('EXPENSE_CORRECTION_TARGET_NOT_ACTIVE');
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operationId: string,
    postingDate: string,
  ): Promise<AccountingPeriodPostingContext> {
    try {
      return await this.postingContext.resolveForWrite(transaction, context, {
        operationId,
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

  private requireReplacementPostingDate(value: string | null): string {
    if (value === null) throw new Error('Replacement posting date is missing.');
    return value;
  }

  private async lockActiveStore(transaction: DatabaseTransaction, storeId: string): Promise<void> {
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

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand | ExpensePaymentCorrectionCommand,
    action: string,
  ): Promise<ExpenseCorrectionResult | null> {
    let claimed = false;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'expense_corrections',
            ${command.operationId}::uuid, ${action}, ${command.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
    }
    if (claimed) return null;
    const existing = await this.readOperation(transaction, context.storeId, command.operationId);
    if (!existing) throw new Error('Expense correction operation claim is missing.');
    return this.replay(transaction, context, command, action, existing);
  }

  private async lockTargetOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    return (
      await transaction.execute<ProcessedOperationRow>(sql`
        select device_id as "deviceId", aggregate_type as "aggregateType",
          aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
          response_code as "responseCode", response_body as "responseBody",
          error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        for update
      `)
    ).rows[0];
  }

  private async readOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    return (
      await transaction.execute<ProcessedOperationRow>(sql`
        select device_id as "deviceId", aggregate_type as "aggregateType",
          aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
          response_code as "responseCode", response_body as "responseBody",
          error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
      `)
    ).rows[0];
  }

  private async replay(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: ExpenseRecognitionCorrectionCommand | ExpensePaymentCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<ExpenseCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'expense_corrections' ||
      row.aggregateId !== command.operationId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id,operation_id,entity_type,entity_id,conflict_type,client_payload)
        values(
          ${context.storeId}::uuid,${command.operationId}::uuid,'expense_corrections',
          ${command.operationId}::uuid,'duplicate_identity',
          jsonb_build_object('action',${action}::text,'requestHash',${command.requestHash}::text))
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) throw new Error('Invalid Expense correction replay status.');
      return { ok: true, response: parseStoredExpenseCorrectionResponse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (
        !code ||
        !Object.hasOwn(failures, code) ||
        row.responseCode !== failures[code as ExpenseCorrectionFailureCode].statusCode
      ) {
        throw new Error('Invalid Expense correction rejection status.');
      }
      return failure(code as ExpenseCorrectionFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private knownFailure(error: unknown): ExpenseCorrectionFailure | undefined {
    if (error instanceof ExpenseCorrectionRejectedError) return error.error;
    if (error instanceof ExpenseRecognitionRejectedError) {
      return failures[error.result.error.code];
    }
    if (error instanceof ExpensePaymentRejectedError) return failures[error.result.error.code];
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: ExpenseCorrectionResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied',response_code=201,
        response_body=${JSON.stringify(response)}::jsonb,error_code=null,
        completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Expense correction completion failed.');
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: ExpenseCorrectionFailure,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected',response_code=${error.statusCode},
        response_body=${JSON.stringify({ code: error.code, message: error.message })}::jsonb,
        error_code=${error.code},completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Expense correction rejection failed.');
  }

  private action(
    command: ExpenseRecognitionCorrectionCommand | ExpensePaymentCorrectionCommand,
  ): string {
    return `${command.aggregate === 'expense' ? 'expenses' : 'expense_payments'}.${command.kind}`;
  }
}
