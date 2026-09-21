import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  customerLedgerEntries,
  customerPayments,
  customers,
  moneyAccounts,
  moneyMovements,
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
import {
  CustomerCreditRepository,
  CustomerFinancialRejectedError,
  customerFinancialFailureDefinitions,
} from './customer-credit.repository';
import { parseStoredCustomerFinancialResponse } from './customer-credit-response';
import type {
  CustomerFinancialFailureCode,
  CustomerFinancialResponse,
} from './customer-credit.types';
import {
  correctionAction,
  type CustomerFinancialCorrectionCommand,
  type CustomerFinancialCorrectionFamily,
} from './customer-financial-correction-command';
import { parseStoredCustomerFinancialCorrectionResponse } from './customer-financial-correction-response';
import type {
  CancelledCustomerPayment,
  CustomerFinancialCorrectionFailure,
  CustomerFinancialCorrectionFailureCode,
  CustomerFinancialCorrectionResponse,
  CustomerFinancialCorrectionResult,
  CustomerFinancialLedgerReversal,
  CustomerFinancialMoneyReversal,
} from './customer-financial-correction.types';
import {
  CustomerCollectionRejectedError,
  CustomerPaymentPostingRepository,
  customerCollectionFailureDefinitions,
} from './customer-payment-posting.repository';
import { parseStoredCustomerCollectionPostingResponse } from './customer-payment-posting-response';
import type {
  CustomerCollectionFailureCode,
  CustomerCollectionPostingResponse,
} from './customer-payment-posting.types';
import { CustomerReceivableSettlementRepository } from './customer-receivable-settlement.repository';

const CORRECTION_AGGREGATE = 'customer_financial_corrections';

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

interface PaymentFact extends Record<string, unknown> {
  id: string;
  customerId: string;
  accountingPeriodId: string | null;
  moneyAccountId: string;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  status: 'draft' | 'posted' | 'cancelled';
  moneyMovementId: string | null;
  cancelledAt: string | null;
  operationId: string;
}

interface LedgerFact extends Record<string, unknown> {
  id: string;
  customerId: string;
  accountingPeriodId: string;
  entryType: string;
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  sourceSaleId: string | null;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  occurredAt: string;
  reversalOfId: string | null;
  operationId: string;
}

interface MoneyFact extends Record<string, unknown> {
  id: string;
  accountId: string;
  accountingPeriodId: string;
  movementType: string;
  amountDeltaMinor: string;
  referenceType: string | null;
  referenceId: string | null;
  transactionGroupId: string;
  occurredAt: string;
  reversalOfId: string | null;
  operationId: string;
}

interface AllocationFact extends Record<string, unknown> {
  customerPaymentId: string;
  customerLedgerEntryId: string | null;
  saleId: string | null;
  openingReceivableLedgerEntryId: string | null;
  amountMinor: string;
}

interface TargetDescriptor {
  family: CustomerFinancialCorrectionFamily;
  operationId: string;
  customerId: string;
  transactionGroupId: string;
  collection: CustomerCollectionPostingResponse | null;
  financial: CustomerFinancialResponse | null;
}

interface TargetFacts {
  descriptor: TargetDescriptor;
  payments: PaymentFact[];
  ledger: LedgerFact[];
  money: MoneyFact[];
  allocations: AllocationFact[];
}

const correctionFailures = {
  CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY: {
    code: 'CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY',
    message: 'Customer Credit has dependent activity and cannot be safely reversed.',
    statusCode: 409,
  },
  CUSTOMER_FINANCIAL_CORRECTION_CUSTOMER_MISMATCH: {
    code: 'CUSTOMER_FINANCIAL_CORRECTION_CUSTOMER_MISMATCH',
    message: 'Correction Customer must match the original financial operation.',
    statusCode: 409,
  },
  CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Customer financial correction target is inconsistent.',
    statusCode: 409,
  },
  CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE: {
    code: 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE',
    message: 'Customer financial correction target is not the active operation.',
    statusCode: 409,
  },
  CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND: {
    code: 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND',
    message: 'Customer financial correction target not found.',
    statusCode: 404,
  },
  CUSTOMER_FINANCIAL_CORRECTION_TARGET_TYPE_MISMATCH: {
    code: 'CUSTOMER_FINANCIAL_CORRECTION_TARGET_TYPE_MISMATCH',
    message: 'Customer financial correction target type does not match the route.',
    statusCode: 409,
  },
} as const satisfies Readonly<
  Record<
    Exclude<
      CustomerFinancialCorrectionFailureCode,
      CustomerCollectionFailureCode | CustomerFinancialFailureCode
    >,
    CustomerFinancialCorrectionFailure
  >
>;

const failureDefinitions: Readonly<
  Record<CustomerFinancialCorrectionFailureCode, CustomerFinancialCorrectionFailure>
> = {
  ...customerCollectionFailureDefinitions,
  ...customerFinancialFailureDefinitions,
  ...correctionFailures,
};

class CustomerFinancialCorrectionRejectedError extends Error {
  constructor(readonly error: CustomerFinancialCorrectionFailure) {
    super(error.message);
    this.name = 'CustomerFinancialCorrectionRejectedError';
  }
}

function reject(code: CustomerFinancialCorrectionFailureCode): never {
  throw new CustomerFinancialCorrectionRejectedError(failureDefinitions[code]);
}

function failure(code: CustomerFinancialCorrectionFailureCode): CustomerFinancialCorrectionResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class CustomerFinancialCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly customerPayments: CustomerPaymentPostingRepository,
    private readonly customerCredit: CustomerCreditRepository,
    private readonly receivables: CustomerReceivableSettlementRepository,
    private readonly moneyMovementPosting: MoneyMovementPostingRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    postingDate: string,
  ): Promise<CustomerFinancialCorrectionResult> {
    const action = correctionAction(command.family, command.kind);
    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readOperation(transaction, context.storeId, command.operationId);
      if (prior) return this.replay(transaction, context, command, action, prior);

      await this.lockActiveStore(transaction, context.storeId);
      const claimed = await this.claimOperation(transaction, context, command, action);
      if (claimed) return claimed;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.applyCorrection(savepoint, context, command, postingDate),
        );
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

  private async applyCorrection(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    postingDate: string,
  ): Promise<CustomerFinancialCorrectionResponse> {
    const targetOperation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const descriptor = this.resolveTarget(targetOperation, command);
    if (descriptor.customerId !== command.customerId) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_CUSTOMER_MISMATCH');
    }
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    const customerStatus = await this.lockCustomer(
      transaction,
      context.storeId,
      descriptor.customerId,
    );
    if (command.kind === 'edit' && customerStatus !== 'active') {
      reject('CUSTOMER_UNAVAILABLE');
    }

    const target = await this.loadAndValidateTarget(transaction, context.storeId, descriptor);
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    await this.lockHistoricalMoneyAccounts(transaction, context.storeId, target.money);
    await this.assertNoPriorReversals(transaction, context.storeId, target);
    await this.assertCreditDependency(transaction, context.storeId, target);
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);

    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.reason}::text, true)`,
    );
    const ledgerEffects = await this.insertLedgerReversals(
      transaction,
      context,
      command,
      posting,
      target,
    );
    const movementEffects = await this.insertMoneyReversals(
      transaction,
      context,
      command,
      posting,
      target,
    );
    const cancelledPayments = await this.cancelPayments(transaction, context, command, target);

    const replacement =
      command.kind === 'edit'
        ? await this.insertReplacement(transaction, context, command, postingDate)
        : null;
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.reason}::text, true)`,
    );
    await this.insertAuditFact(transaction, context, command, descriptor, replacement);

    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      customerId: command.customerId,
      family: command.family,
      intent: command.kind,
      reason: command.reason,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      activeOperationId: command.kind === 'edit' ? command.operationId : null,
      target: {
        operationId: descriptor.operationId,
        transactionGroupId: descriptor.transactionGroupId,
        payments: cancelledPayments,
      },
      reversal: { ledgerEffects, moneyMovements: movementEffects },
      replacement,
    };
  }

  private resolveTarget(
    row: ProcessedOperationRow | undefined,
    command: CustomerFinancialCorrectionCommand,
  ): TargetDescriptor {
    if (!row) reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    if (row.responseCode !== 201) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }

    if (
      row.action === 'customer_collections.post' &&
      row.aggregateType === 'customer_collections'
    ) {
      if (command.family !== 'customer_collection') {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_TYPE_MISMATCH');
      }
      const response = this.parseCollection(row.responseBody);
      if (
        row.aggregateId !== command.targetOperationId ||
        response.operationId !== command.targetOperationId ||
        response.collectionId !== deriveTransactionGroupId(command.targetOperationId)
      ) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return {
        family: command.family,
        operationId: command.targetOperationId,
        customerId: response.customerId,
        transactionGroupId: response.collectionId,
        collection: response,
        financial: null,
      };
    }

    const originalFamily = this.familyForFinancialAction(row.action);
    if (originalFamily && row.aggregateType === 'customer_financial_adjustments') {
      if (command.family !== originalFamily) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_TYPE_MISMATCH');
      }
      const response = this.parseFinancial(row.responseBody);
      if (
        row.aggregateId !== command.targetOperationId ||
        response.operationId !== command.targetOperationId ||
        response.transactionGroupId !== deriveTransactionGroupId(command.targetOperationId)
      ) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return {
        family: command.family,
        operationId: command.targetOperationId,
        customerId: response.customerId,
        transactionGroupId: response.transactionGroupId,
        collection: null,
        financial: response,
      };
    }

    if (row.aggregateType === CORRECTION_AGGREGATE && row.action.endsWith('.edit')) {
      const response = this.parseCorrection(row.responseBody);
      const replacement = response.replacement;
      if (
        row.aggregateId !== command.targetOperationId ||
        row.action !== correctionAction(response.family, 'edit') ||
        response.intent !== 'edit' ||
        response.operationId !== command.targetOperationId ||
        response.activeOperationId !== command.targetOperationId ||
        replacement?.operationId !== response.operationId ||
        replacement.customerId !== response.customerId ||
        ('collectionId' in replacement
          ? replacement.collectionId
          : replacement.transactionGroupId) !== deriveTransactionGroupId(response.operationId)
      ) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (response.family !== command.family) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_TYPE_MISMATCH');
      }
      return {
        family: response.family,
        operationId: response.operationId,
        customerId: response.customerId,
        transactionGroupId:
          response.family === 'customer_collection'
            ? (replacement as CustomerCollectionPostingResponse).collectionId
            : (replacement as CustomerFinancialResponse).transactionGroupId,
        collection:
          response.family === 'customer_collection'
            ? (replacement as CustomerCollectionPostingResponse)
            : null,
        financial:
          response.family === 'customer_collection'
            ? null
            : (replacement as CustomerFinancialResponse),
      };
    }
    if (row.aggregateType === CORRECTION_AGGREGATE && row.action.endsWith('.cancel')) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    }
    reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
  }

  private parseCollection(value: unknown): CustomerCollectionPostingResponse {
    try {
      return parseStoredCustomerCollectionPostingResponse(value);
    } catch {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private parseFinancial(value: unknown): CustomerFinancialResponse {
    try {
      return parseStoredCustomerFinancialResponse(value);
    } catch {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private parseCorrection(value: unknown): CustomerFinancialCorrectionResponse {
    try {
      return parseStoredCustomerFinancialCorrectionResponse(value);
    } catch {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private familyForFinancialAction(action: string): CustomerFinancialCorrectionFamily | null {
    if (action === 'apply_customer_credit') return 'customer_credit_application';
    if (action === 'refund_customer_credit') return 'customer_credit_refund';
    if (action === 'settle_receivable') return 'customer_receivable_settlement';
    return null;
  }

  private async lockCustomer(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<'active' | 'archived'> {
    const rows = await transaction
      .select({ status: customers.status })
      .from(customers)
      .where(and(eq(customers.storeId, storeId), eq(customers.id, customerId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    return row.status;
  }

  private async loadAndValidateTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    descriptor: TargetDescriptor,
  ): Promise<TargetFacts> {
    const paymentIds = descriptor.collection?.payments.map((payment) => payment.id) ?? [];
    const payments =
      paymentIds.length === 0
        ? []
        : (
            await transaction.execute<PaymentFact>(sql`
              select id, customer_id as "customerId",
                accounting_period_id as "accountingPeriodId",
                money_account_id as "moneyAccountId", amount_minor::text as "amountMinor",
                allocated_total_minor::text as "allocatedTotalMinor",
                credit_created_minor::text as "creditCreatedMinor", status,
                money_movement_id as "moneyMovementId", cancelled_at as "cancelledAt",
                operation_id as "operationId"
              from ledger.customer_payments
              where store_id=${storeId}::uuid and id in (
                ${sql.join(
                  paymentIds.map((paymentId) => sql`${paymentId}::uuid`),
                  sql`,`,
                )}
              )
              order by id for update
            `)
          ).rows;
    const ledger = (
      await transaction.execute<LedgerFact>(sql`
        select id, customer_id as "customerId", accounting_period_id as "accountingPeriodId",
          entry_type as "entryType", receivable_delta_minor::text as "receivableDeltaMinor",
          credit_delta_minor::text as "creditDeltaMinor", source_sale_id as "sourceSaleId",
          reference_type as "referenceType", reference_id as "referenceId",
          transaction_group_id as "transactionGroupId", occurred_at as "occurredAt",
          reversal_of_id as "reversalOfId", operation_id as "operationId"
        from ledger.customer_ledger_entries
        where store_id=${storeId}::uuid
          and transaction_group_id=${descriptor.transactionGroupId}::uuid
          and reversal_of_id is null
        order by id for update
      `)
    ).rows;
    const money = (
      await transaction.execute<MoneyFact>(sql`
        select id, account_id as "accountId", accounting_period_id as "accountingPeriodId",
          movement_type as "movementType", amount_delta_minor::text as "amountDeltaMinor",
          reference_type as "referenceType", reference_id as "referenceId",
          transaction_group_id as "transactionGroupId", occurred_at as "occurredAt",
          reversal_of_id as "reversalOfId", operation_id as "operationId"
        from ledger.money_movements
        where store_id=${storeId}::uuid
          and transaction_group_id=${descriptor.transactionGroupId}::uuid
          and reversal_of_id is null
        order by id for update
      `)
    ).rows;
    const allocations =
      paymentIds.length === 0
        ? []
        : (
            await transaction.execute<AllocationFact>(sql`
              select customer_payment_id as "customerPaymentId",
                customer_ledger_entry_id as "customerLedgerEntryId", sale_id as "saleId",
                opening_receivable_ledger_entry_id as "openingReceivableLedgerEntryId",
                amount_minor::text as "amountMinor"
              from ledger.customer_payment_allocations
              where store_id=${storeId}::uuid and customer_payment_id in (
                ${sql.join(
                  paymentIds.map((paymentId) => sql`${paymentId}::uuid`),
                  sql`,`,
                )}
              )
              order by id
            `)
          ).rows;

    const target = { descriptor, payments, ledger, money, allocations };
    this.assertTargetIntegrity(target);
    return target;
  }

  private assertTargetIntegrity(target: TargetFacts): void {
    const { descriptor, payments, ledger, money, allocations } = target;
    if (
      ledger.some(
        (entry) =>
          entry.customerId !== descriptor.customerId ||
          entry.transactionGroupId !== descriptor.transactionGroupId ||
          entry.reversalOfId !== null,
      ) ||
      money.some(
        (movement) =>
          movement.transactionGroupId !== descriptor.transactionGroupId ||
          movement.reversalOfId !== null,
      )
    ) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }

    if (descriptor.collection) {
      const response = descriptor.collection;
      if (
        payments.length !== response.payments.length ||
        money.length !== response.moneyMovements.length ||
        allocations.length !== response.allocations.length
      ) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const responsePayments = new Map(response.payments.map((payment) => [payment.id, payment]));
      for (const payment of payments) {
        const expected = responsePayments.get(payment.id);
        const allocationTotal = allocations
          .filter((allocation) => allocation.customerPaymentId === payment.id)
          .reduce((sum, allocation) => sum + BigInt(allocation.amountMinor), 0n);
        const creditTotal = ledger
          .filter(
            (entry) =>
              entry.entryType === 'credit_created' &&
              entry.referenceType === 'customer_payment' &&
              entry.referenceId === payment.id,
          )
          .reduce((sum, entry) => sum + BigInt(entry.creditDeltaMinor), 0n);
        if (
          !expected ||
          payment.customerId !== descriptor.customerId ||
          payment.accountingPeriodId !== response.accountingPeriodId ||
          payment.status !== 'posted' ||
          payment.cancelledAt !== null ||
          payment.moneyMovementId !== expected.moneyMovementId ||
          payment.operationId !== expected.operationId ||
          payment.amountMinor !== expected.amountMinor ||
          payment.allocatedTotalMinor !== expected.allocatedTotalMinor ||
          payment.creditCreatedMinor !== expected.creditCreatedMinor ||
          allocationTotal !== BigInt(payment.allocatedTotalMinor) ||
          creditTotal !== BigInt(payment.creditCreatedMinor)
        ) {
          reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
      }
      const allocationLedgerIds = new Set(
        allocations.map((allocation) => allocation.customerLedgerEntryId),
      );
      if (
        allocations.some((allocation) => allocation.customerLedgerEntryId === null) ||
        ledger
          .filter((entry) => entry.entryType === 'payment')
          .some((entry) => !allocationLedgerIds.has(entry.id))
      ) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const responseMovementIds = new Set(response.moneyMovements.map((movement) => movement.id));
      if (money.some((movement) => !responseMovementIds.has(movement.id))) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    } else {
      const response = descriptor.financial;
      if (!response || payments.length !== 0 || allocations.length !== 0) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const expectedLedgerIds = new Set(response.ledgerEffects.map((effect) => effect.id));
      if (
        ledger.length !== expectedLedgerIds.size ||
        ledger.some((entry) => !expectedLedgerIds.has(entry.id)) ||
        money.length !== (response.moneyMovement ? 1 : 0) ||
        (response.moneyMovement !== null && money[0]?.id !== response.moneyMovement.id)
      ) {
        reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
  }

  private async lockHistoricalMoneyAccounts(
    transaction: DatabaseTransaction,
    storeId: string,
    facts: MoneyFact[],
  ): Promise<void> {
    for (const accountId of [...new Set(facts.map((fact) => fact.accountId))].sort()) {
      const rows = await transaction
        .select({ id: moneyAccounts.id })
        .from(moneyAccounts)
        .where(and(eq(moneyAccounts.storeId, storeId), eq(moneyAccounts.id, accountId)))
        .limit(1)
        .for('update');
      if (!rows[0]) reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async assertNoPriorReversals(
    transaction: DatabaseTransaction,
    storeId: string,
    target: TargetFacts,
  ): Promise<void> {
    const ledgerIds = target.ledger.map((entry) => entry.id);
    const moneyIds = target.money.map((movement) => movement.id);
    const priorLedger =
      ledgerIds.length === 0
        ? []
        : await transaction
            .select({ id: customerLedgerEntries.id })
            .from(customerLedgerEntries)
            .where(
              and(
                eq(customerLedgerEntries.storeId, storeId),
                inArray(customerLedgerEntries.reversalOfId, ledgerIds),
              ),
            )
            .limit(1);
    const priorMoney =
      moneyIds.length === 0
        ? []
        : await transaction
            .select({ id: moneyMovements.id })
            .from(moneyMovements)
            .where(
              and(
                eq(moneyMovements.storeId, storeId),
                inArray(moneyMovements.reversalOfId, moneyIds),
              ),
            )
            .limit(1);
    if (priorLedger.length || priorMoney.length) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    }
  }

  private async assertCreditDependency(
    transaction: DatabaseTransaction,
    storeId: string,
    target: TargetFacts,
  ): Promise<void> {
    const creditCreated = target.ledger.reduce(
      (sum, entry) => sum + BigInt(entry.creditDeltaMinor),
      0n,
    );
    if (creditCreated <= 0n) return;
    const available = await this.receivables.readAvailableCredit(
      transaction,
      storeId,
      target.descriptor.customerId,
    );
    if (available < creditCreated) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY');
    }
  }

  private async insertLedgerReversals(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: TargetFacts,
  ): Promise<CustomerFinancialLedgerReversal[]> {
    const allocationByLedger = new Map<string, AllocationFact>();
    for (const allocation of target.allocations) {
      if (allocation.customerLedgerEntryId !== null) {
        allocationByLedger.set(allocation.customerLedgerEntryId, allocation);
      }
    }
    const effects: CustomerFinancialLedgerReversal[] = [];
    for (const original of target.ledger) {
      const discriminator = `customer-financial-ledger-reversal:${original.id}`;
      const operationId = deriveMoneyFactOperationId(command.operationId, discriminator);
      const rows = await transaction
        .insert(customerLedgerEntries)
        .values({
          id: deriveMoneyFactId(command.operationId, discriminator),
          storeId: context.storeId,
          customerId: original.customerId,
          accountingPeriodId: posting.accountingPeriodId,
          entryType: 'correction',
          receivableDeltaMinor: -BigInt(original.receivableDeltaMinor),
          creditDeltaMinor: -BigInt(original.creditDeltaMinor),
          sourceSaleId: original.sourceSaleId,
          referenceType: original.referenceType,
          referenceId: original.referenceId,
          transactionGroupId: deriveTransactionGroupId(command.operationId),
          occurredAt: command.occurredAt,
          reversalOfId: original.id,
          reason: command.reason,
          deviceId: context.deviceId,
          operationId,
        })
        .returning({ id: customerLedgerEntries.id, createdAt: customerLedgerEntries.createdAt });
      const row = rows[0];
      if (!row) throw new Error('Customer financial ledger reversal did not return a row.');
      const allocation = allocationByLedger.get(original.id);
      const targetType = original.sourceSaleId
        ? ('sale_receivable' as const)
        : original.referenceType === 'customer_opening_receivable' ||
            allocation?.openingReceivableLedgerEntryId
          ? ('opening_receivable' as const)
          : null;
      const targetId =
        targetType === 'sale_receivable'
          ? original.sourceSaleId
          : targetType === 'opening_receivable'
            ? (allocation?.openingReceivableLedgerEntryId ?? original.referenceId)
            : null;
      effects.push({
        id: row.id,
        operationId,
        entryType: 'correction',
        receivableDeltaMinor: (-BigInt(original.receivableDeltaMinor)).toString(),
        creditDeltaMinor: (-BigInt(original.creditDeltaMinor)).toString(),
        targetType,
        targetId,
        reversalOfId: original.id,
        reason: command.reason,
        occurredAt: command.occurredAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      });
    }
    return effects;
  }

  private async insertMoneyReversals(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: TargetFacts,
  ): Promise<CustomerFinancialMoneyReversal[]> {
    const effects: CustomerFinancialMoneyReversal[] = [];
    for (const original of [...target.money].sort((left, right) =>
      left.accountId === right.accountId
        ? left.id.localeCompare(right.id)
        : left.accountId.localeCompare(right.accountId),
    )) {
      const movement = await this.moneyMovementPosting.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: `customer-financial-money-reversal:${original.id}`,
          accountId: original.accountId,
          amountDeltaMinor: -BigInt(original.amountDeltaMinor),
          movementType: 'correction',
          referenceType: 'customer_financial_correction',
          referenceId: command.targetOperationId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId: deriveTransactionGroupId(command.operationId),
          notes: command.reason,
          reversalOfId: original.id,
        },
      );
      effects.push({
        ...movement,
        movementType: 'correction',
        reversalOfId: original.id,
      });
    }
    return effects;
  }

  private async cancelPayments(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    target: TargetFacts,
  ): Promise<CancelledCustomerPayment[]> {
    if (target.payments.length === 0) return [];
    const ids = target.payments.map((payment) => payment.id);
    const rows = await transaction
      .update(customerPayments)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(customerPayments.storeId, context.storeId),
          inArray(customerPayments.id, ids),
          eq(customerPayments.status, 'posted'),
        ),
      )
      .returning({ id: customerPayments.id, version: customerPayments.version });
    if (rows.length !== ids.length) reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    return rows
      .map((row) => ({
        id: row.id,
        status: 'cancelled' as const,
        cancelledAt: command.occurredAt.toISOString(),
        version: row.version.toString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private insertReplacement(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: Extract<CustomerFinancialCorrectionCommand, { kind: 'edit' }>,
    postingDate: string,
  ): Promise<CustomerCollectionPostingResponse | CustomerFinancialResponse> {
    if (command.family === 'customer_collection' && 'tenders' in command.replacement) {
      return this.customerPayments.insertCollectionWithinTransaction(
        transaction,
        context,
        command.replacement,
        postingDate,
      );
    }
    if ('action' in command.replacement) {
      return this.customerCredit.insertFinancialWithinTransaction(
        transaction,
        context,
        command.replacement,
        postingDate,
      );
    }
    throw new Error('Customer financial correction replacement is inconsistent.');
  }

  private async insertAuditFact(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    descriptor: TargetDescriptor,
    replacement: CustomerCollectionPostingResponse | CustomerFinancialResponse | null,
  ): Promise<void> {
    const auditId = deriveMoneyFactId(command.operationId, 'customer-financial-correction-audit');
    await transaction.execute(sql`
      insert into ledger.audit_logs(
        id,store_id,device_id,actor_type,action,entity_type,entity_id,
        old_values_json,new_values_json,reason,operation_id,occurred_at
      ) values(
        ${auditId}::uuid,${context.storeId}::uuid,${context.deviceId}::uuid,'owner',
        ${correctionAction(command.family, command.kind)},'customer_financial_operation',
        ${command.targetOperationId}::uuid,
        ${JSON.stringify({
          operationId: descriptor.operationId,
          customerId: descriptor.customerId,
          family: descriptor.family,
          transactionGroupId: descriptor.transactionGroupId,
        })}::jsonb,
        ${JSON.stringify({
          correctionOperationId: command.operationId,
          intent: command.kind,
          activeOperationId: command.kind === 'edit' ? command.operationId : null,
          replacementOperationId: replacement?.operationId ?? null,
        })}::jsonb,
        ${command.reason},${command.operationId}::uuid,${command.occurredAt}
      )
    `);
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
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

  private async assertTargetIsActive(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ superseded: boolean }>(sql`
      select exists(
        select 1 from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied'
          and aggregate_type=${CORRECTION_AGGREGATE}
          and response_body ->> 'targetOperationId'=${targetOperationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded) {
      reject('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    }
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
    command: CustomerFinancialCorrectionCommand,
    action: string,
  ): Promise<CustomerFinancialCorrectionResult | null> {
    let claimed = false;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,${command.operationId}::uuid,${context.deviceId}::uuid,
            ${CORRECTION_AGGREGATE},${command.operationId}::uuid,${action},${command.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
    }
    if (claimed) return null;
    const existing = await this.readOperation(transaction, context.storeId, command.operationId);
    if (!existing) throw new Error('Customer financial correction operation claim is missing.');
    return this.replay(transaction, context, command, action, existing);
  }

  private async lockTargetOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    return (
      await transaction.execute<ProcessedOperationRow>(sql`
        select device_id as "deviceId",aggregate_type as "aggregateType",
          aggregate_id as "aggregateId",action,request_hash as "requestHash",status,
          response_code as "responseCode",response_body as "responseBody",error_code as "errorCode"
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
        select device_id as "deviceId",aggregate_type as "aggregateType",
          aggregate_id as "aggregateId",action,request_hash as "requestHash",status,
          response_code as "responseCode",response_body as "responseBody",error_code as "errorCode"
        from sync.processed_operations
        where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
      `)
    ).rows[0];
  }

  private async replay(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerFinancialCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<CustomerFinancialCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== CORRECTION_AGGREGATE ||
      row.aggregateId !== command.operationId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id,operation_id,entity_type,entity_id,conflict_type,client_payload
        ) values(
          ${context.storeId}::uuid,${command.operationId}::uuid,${CORRECTION_AGGREGATE},
          ${command.operationId}::uuid,'duplicate_identity',
          jsonb_build_object('action',${action}::text,'requestHash',${command.requestHash}::text)
        )
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) {
        throw new Error('Invalid Customer financial correction replay status.');
      }
      return {
        ok: true,
        response: parseStoredCustomerFinancialCorrectionResponse(row.responseBody),
      };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (
        !code ||
        !Object.hasOwn(failureDefinitions, code) ||
        row.responseCode !==
          failureDefinitions[code as CustomerFinancialCorrectionFailureCode].statusCode
      ) {
        throw new Error('Invalid Customer financial correction rejection status.');
      }
      return failure(code as CustomerFinancialCorrectionFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private knownFailure(error: unknown): CustomerFinancialCorrectionFailure | undefined {
    if (error instanceof CustomerFinancialCorrectionRejectedError) return error.error;
    if (error instanceof CustomerCollectionRejectedError) return error.result.error;
    if (error instanceof CustomerFinancialRejectedError) return error.result.error;
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: CustomerFinancialCorrectionResponse,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied',response_code=201,response_body=${JSON.stringify(response)}::jsonb,
        error_code=null,completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Customer financial correction completion failed.');
    }
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: CustomerFinancialCorrectionFailure,
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
    if (completed.rows.length !== 1) {
      throw new Error('Customer financial correction rejection failed.');
    }
  }
}
