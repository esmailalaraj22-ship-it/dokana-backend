import { HttpException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  customerLedgerEntries,
  customerPaymentAllocations,
  customerPayments,
} from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import {
  partitionCustomerPayment,
  type CustomerPaymentAllocationMatrixItem,
  type CustomerReceivableSettlementPlanItem,
} from './customer-payment-allocation';
import type {
  CustomerCollectionPostingCommand,
  CustomerReceivableTargetType,
} from './customer-payment-posting-command';
import { parseStoredCustomerCollectionPostingResponse } from './customer-payment-posting-response';
import {
  CustomerReceivablePlanningError,
  CustomerReceivableSettlementRepository,
} from './customer-receivable-settlement.repository';
import type {
  CustomerCollectionFailure,
  CustomerCollectionFailureCode,
  CustomerCollectionPostingResponse,
  CustomerCollectionPostingResult,
  PostedCustomerCollectionAllocation,
  PostedCustomerCollectionPayment,
} from './customer-payment-posting.types';

const CUSTOMER_COLLECTION_AGGREGATE = 'customer_collections';
const CUSTOMER_COLLECTION_ACTION = 'customer_collections.post';

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
  error: CustomerCollectionFailure;
}

export const customerCollectionFailureDefinitions: Readonly<
  Record<CustomerCollectionFailureCode, CustomerCollectionFailure>
> = {
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
    message: 'Customer collection allocation exceeds the current outstanding amount.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING: {
    code: 'CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING',
    message: 'Customer collection exceeds the current outstanding amount.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH: {
    code: 'CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH',
    message: 'Customer collection target belongs to a different Customer.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Customer collection target is inconsistent.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE: {
    code: 'CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE',
    message: 'Customer collection target is not active.',
    statusCode: 409,
  },
  CUSTOMER_COLLECTION_TARGET_NOT_FOUND: {
    code: 'CUSTOMER_COLLECTION_TARGET_NOT_FOUND',
    message: 'Customer collection target not found.',
    statusCode: 404,
  },
  CUSTOMER_OVERPAYMENT_CHOICE_REQUIRED: {
    code: 'CUSTOMER_OVERPAYMENT_CHOICE_REQUIRED',
    message: 'Explicit overpayment handling is required.',
    statusCode: 409,
  },
  CUSTOMER_OVERPAYMENT_NOT_PRESENT: {
    code: 'CUSTOMER_OVERPAYMENT_NOT_PRESENT',
    message: 'Overpayment handling was supplied but no excess exists.',
    statusCode: 409,
  },
  CUSTOMER_NOT_FOUND: {
    code: 'CUSTOMER_NOT_FOUND',
    message: 'Customer not found.',
    statusCode: 404,
  },
  CUSTOMER_UNAVAILABLE: {
    code: 'CUSTOMER_UNAVAILABLE',
    message: 'Customer is not available for new collections.',
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

export class CustomerCollectionRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'CustomerCollectionRejectedError';
  }
}

function failure(code: CustomerCollectionFailureCode): FailureResult {
  return { ok: false, error: customerCollectionFailureDefinitions[code] };
}

function reject(code: CustomerCollectionFailureCode): never {
  throw new CustomerCollectionRejectedError(failure(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class CustomerPaymentPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly receivables: CustomerReceivableSettlementRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
    postingDate: string,
  ): Promise<CustomerCollectionPostingResult> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, command);
      if (begun) return begun;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.insertCollectionWithinTransaction(savepoint, context, command, postingDate),
        );
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  async insertCollectionWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
    postingDate: string,
  ): Promise<CustomerCollectionPostingResponse> {
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    let settlementPlan: CustomerReceivableSettlementPlanItem[];
    let excessMinor: bigint;
    try {
      await this.receivables.lockActiveCustomer(transaction, context.storeId, command.customerId);
      if (command.intent === 'customer_advance') {
        settlementPlan = [];
        excessMinor = command.amountMinor;
      } else if (command.allocationMode === 'custom') {
        const allocatedMinor = command.allocations.reduce(
          (total, allocation) => total + allocation.amountMinor,
          0n,
        );
        const planned = await this.receivables.buildPlan(
          transaction,
          context.storeId,
          command.customerId,
          command.allocationMode,
          allocatedMinor,
          command.allocations,
          false,
        );
        settlementPlan = planned.plan;
        excessMinor = command.amountMinor - allocatedMinor;
      } else {
        const planned = await this.receivables.buildPlan(
          transaction,
          context.storeId,
          command.customerId,
          command.allocationMode,
          command.amountMinor,
          command.allocations,
          true,
        );
        settlementPlan = planned.plan;
        excessMinor = planned.unappliedMinor;
      }
    } catch (error) {
      if (error instanceof CustomerReceivablePlanningError) reject(error.code);
      throw error;
    }
    if (command.intent === 'collect_receivable') {
      if (settlementPlan.length === 0 && excessMinor > 0n) {
        reject('CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING');
      }
      if (excessMinor > 0n && command.overpaymentHandling === null) {
        reject('CUSTOMER_OVERPAYMENT_CHOICE_REQUIRED');
      }
      if (excessMinor === 0n && command.overpaymentHandling !== null) {
        reject('CUSTOMER_OVERPAYMENT_NOT_PRESENT');
      }
    }

    const partition = partitionCustomerPayment(command.tenders, settlementPlan);
    const partitionByAccount = new Map(
      partition.tenders.map((item) => [item.moneyAccountId, item]),
    );
    await this.lockAndValidateMoneyAccounts(transaction, context.storeId, [
      ...command.tenders.map((tender) => tender.moneyAccountId),
      ...(command.refundMoneyAccountId ? [command.refundMoneyAccountId] : []),
    ]);

    await transaction.execute(
      sql`select set_config('app.audit_reason', 'Customer collection posted', true)`,
    );
    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    const paymentIds = new Map<string, string>();
    for (const tender of command.tenders) {
      const tenderPartition = partitionByAccount.get(tender.moneyAccountId);
      if (!tenderPartition) throw new Error('Customer Payment partition is missing.');
      const id = this.paymentId(command.operationId, tender.moneyAccountId);
      paymentIds.set(tender.moneyAccountId, id);
      await transaction.insert(customerPayments).values({
        id,
        storeId: context.storeId,
        customerId: command.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        moneyAccountId: tender.moneyAccountId,
        amountMinor: tender.amountMinor,
        allocatedTotalMinor: tenderPartition.allocatedMinor,
        creditCreatedMinor: tenderPartition.creditCreatedMinor,
        paymentAt: command.occurredAt,
        senderAccountName: tender.senderAccountName,
        externalReference: tender.externalReference,
        notes: tender.notes,
        status: 'draft',
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          this.paymentDiscriminator(tender.moneyAccountId),
        ),
      });
    }

    const moneyMovements: PostedMoneyMovement[] = [];
    for (const tender of command.tenders) {
      const paymentId = paymentIds.get(tender.moneyAccountId);
      if (!paymentId) throw new Error('Customer Payment identity is missing.');
      moneyMovements.push(
        await this.moneyMovements.insertMovementWithinTransaction(transaction, context, {
          commandOperationId: command.operationId,
          discriminator: `customer-collection-money:${tender.moneyAccountId}`,
          accountId: tender.moneyAccountId,
          amountDeltaMinor: tender.amountMinor,
          movementType: 'customer_payment',
          referenceType: 'customer_payment',
          referenceId: paymentId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          externalReference: tender.externalReference,
          notes: tender.notes,
        }),
      );
    }

    const allocations = await this.insertAllocationMatrix(
      transaction,
      context,
      command,
      posting,
      paymentIds,
      partition.allocations,
    );
    await this.insertCreditCreatedEntries(
      transaction,
      context,
      command,
      posting,
      paymentIds,
      partition.tenders,
    );

    let refundMovement: PostedMoneyMovement | null = null;
    if (command.overpaymentHandling === 'refund_excess') {
      if (!command.refundMoneyAccountId || excessMinor <= 0n) {
        throw new Error('Customer overpayment refund state is inconsistent.');
      }
      const refundLedgerId = deriveMoneyFactId(
        command.operationId,
        'customer-excess-refund-ledger',
      );
      await transaction.insert(customerLedgerEntries).values({
        id: refundLedgerId,
        storeId: context.storeId,
        customerId: command.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'refund',
        receivableDeltaMinor: 0n,
        creditDeltaMinor: -excessMinor,
        sourceSaleId: null,
        referenceType: 'customer_credit_refund',
        referenceId: refundLedgerId,
        transactionGroupId,
        occurredAt: command.occurredAt,
        reason: 'Immediate Customer overpayment refund',
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          'customer-excess-refund-ledger',
        ),
      });
      refundMovement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: 'customer-excess-refund-money',
          accountId: command.refundMoneyAccountId,
          amountDeltaMinor: -excessMinor,
          movementType: 'customer_refund',
          referenceType: 'customer_credit_refund',
          referenceId: refundLedgerId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          notes: 'Immediate Customer overpayment refund',
        },
      );
      moneyMovements.push(refundMovement);
    }
    const movementByAccount = new Map(
      moneyMovements
        .filter((movement) => movement.movementType === 'customer_payment')
        .map((movement) => [movement.accountId, movement]),
    );
    const payments: PostedCustomerCollectionPayment[] = [];
    for (const tender of command.tenders) {
      const paymentId = paymentIds.get(tender.moneyAccountId);
      const movement = movementByAccount.get(tender.moneyAccountId);
      if (!paymentId || !movement)
        throw new Error('Customer Payment finalization state is missing.');
      const tenderPartition = partitionByAccount.get(tender.moneyAccountId);
      if (!tenderPartition) throw new Error('Customer Payment partition is missing.');
      const rows = await transaction
        .update(customerPayments)
        .set({ status: 'posted', moneyMovementId: movement.id })
        .where(
          and(
            eq(customerPayments.storeId, context.storeId),
            eq(customerPayments.id, paymentId),
            eq(customerPayments.status, 'draft'),
          ),
        )
        .returning({ version: customerPayments.version });
      const row = rows[0];
      if (!row) throw new Error('Customer Payment finalization did not return a row.');
      payments.push({
        id: paymentId,
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          this.paymentDiscriminator(tender.moneyAccountId),
        ),
        moneyAccountId: tender.moneyAccountId,
        amountMinor: tender.amountMinor.toString(),
        allocatedTotalMinor: tenderPartition.allocatedMinor.toString(),
        creditCreatedMinor: tenderPartition.creditCreatedMinor.toString(),
        paymentAt: command.occurredAt.toISOString(),
        senderAccountName: tender.senderAccountName,
        externalReference: tender.externalReference,
        notes: tender.notes,
        status: 'posted',
        moneyMovementId: movement.id,
        version: row.version.toString(),
      });
    }

    return {
      operationId: command.operationId,
      collectionId: transactionGroupId,
      customerId: command.customerId,
      intent: command.intent,
      allocationMode: command.allocationMode,
      overpaymentHandling: command.overpaymentHandling,
      amountMinor: command.amountMinor.toString(),
      excessMinor: excessMinor.toString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      payments,
      allocations,
      moneyMovements,
      refundMovement,
    };
  }

  private async insertAllocationMatrix(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
    posting: AccountingPeriodPostingContext,
    paymentIds: Map<string, string>,
    matrix: CustomerPaymentAllocationMatrixItem[],
  ): Promise<PostedCustomerCollectionAllocation[]> {
    const allocations: PostedCustomerCollectionAllocation[] = [];
    for (const item of matrix) {
      const paymentId = paymentIds.get(item.moneyAccountId);
      if (!paymentId) throw new Error('Customer Payment allocation parent is missing.');
      const discriminator = this.allocationDiscriminator(
        item.moneyAccountId,
        item.targetType,
        item.targetId,
      );
      const ledgerDiscriminator = `customer-collection-ledger:${discriminator}`;
      const ledgerEntryId = deriveMoneyFactId(command.operationId, ledgerDiscriminator);
      const ledgerOperationId = deriveMoneyFactOperationId(
        command.operationId,
        ledgerDiscriminator,
      );
      await transaction.insert(customerLedgerEntries).values({
        id: ledgerEntryId,
        storeId: context.storeId,
        customerId: command.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'payment',
        receivableDeltaMinor: -item.amountMinor,
        creditDeltaMinor: 0n,
        sourceSaleId: item.targetType === 'sale_receivable' ? item.targetId : null,
        referenceType: 'customer_payment',
        referenceId: paymentId,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        occurredAt: command.occurredAt,
        reason:
          command.tenders.find((tender) => tender.moneyAccountId === item.moneyAccountId)?.notes ??
          null,
        deviceId: context.deviceId,
        operationId: ledgerOperationId,
      });
      const rows = await transaction
        .insert(customerPaymentAllocations)
        .values({
          id: deriveMoneyFactId(command.operationId, discriminator),
          storeId: context.storeId,
          customerPaymentId: paymentId,
          saleId: item.targetType === 'sale_receivable' ? item.targetId : null,
          openingReceivableLedgerEntryId:
            item.targetType === 'opening_receivable' ? item.targetId : null,
          amountMinor: item.amountMinor,
          customerLedgerEntryId: ledgerEntryId,
        })
        .returning({
          id: customerPaymentAllocations.id,
          createdAt: customerPaymentAllocations.createdAt,
        });
      const row = rows[0];
      if (!row) throw new Error('Customer Payment allocation insertion did not return a row.');
      allocations.push({
        id: row.id,
        customerPaymentId: paymentId,
        targetType: item.targetType,
        targetId: item.targetId,
        amountMinor: item.amountMinor.toString(),
        customerLedgerEntryId: ledgerEntryId,
        paymentEffectOperationId: ledgerOperationId,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return allocations;
  }

  private async insertCreditCreatedEntries(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
    posting: AccountingPeriodPostingContext,
    paymentIds: Map<string, string>,
    partitions: {
      moneyAccountId: string;
      allocatedMinor: bigint;
      creditCreatedMinor: bigint;
    }[],
  ): Promise<void> {
    for (const partition of partitions) {
      if (partition.creditCreatedMinor === 0n) continue;
      const paymentId = paymentIds.get(partition.moneyAccountId);
      if (!paymentId) throw new Error('Customer Credit payment parent is missing.');
      const discriminator = `customer-credit-created:${partition.moneyAccountId}`;
      await transaction.insert(customerLedgerEntries).values({
        id: deriveMoneyFactId(command.operationId, discriminator),
        storeId: context.storeId,
        customerId: command.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'credit_created',
        receivableDeltaMinor: 0n,
        creditDeltaMinor: partition.creditCreatedMinor,
        sourceSaleId: null,
        referenceType: 'customer_payment',
        referenceId: paymentId,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        occurredAt: command.occurredAt,
        reason:
          command.intent === 'customer_advance'
            ? 'Customer advance'
            : 'Customer overpayment retained as credit',
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(command.operationId, discriminator),
      });
    }
  }

  private async lockAndValidateMoneyAccounts(
    transaction: DatabaseTransaction,
    storeId: string,
    accountIds: string[],
  ): Promise<void> {
    try {
      await this.moneyMovements.lockAndValidateAccounts(transaction, storeId, [
        ...new Set(accountIds),
      ]);
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

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
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

  private paymentDiscriminator(moneyAccountId: string): string {
    return `customer-payment:${moneyAccountId}`;
  }

  private paymentId(operationId: string, moneyAccountId: string): string {
    return deriveMoneyFactId(operationId, this.paymentDiscriminator(moneyAccountId));
  }

  private allocationDiscriminator(
    moneyAccountId: string,
    targetType: CustomerReceivableTargetType,
    targetId: string,
  ): string {
    return `customer-collection-allocation:${moneyAccountId}:${targetType}:${targetId}`;
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
  ): Promise<CustomerCollectionPostingResult | null> {
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
            ${CUSTOMER_COLLECTION_AGGREGATE}, ${command.operationId}::uuid,
            ${CUSTOMER_COLLECTION_ACTION}, ${command.requestHash}
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
    if (!existing) throw new Error('Claimed Customer collection operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, command, existing);
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
    command: CustomerCollectionPostingCommand,
    existing: ProcessedOperationRow,
  ): Promise<CustomerCollectionPostingResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== CUSTOMER_COLLECTION_AGGREGATE ||
      existing.aggregateId !== command.operationId ||
      existing.action !== CUSTOMER_COLLECTION_ACTION ||
      existing.requestHash !== command.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, command);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredCustomerCollectionPostingResponse(existing.responseBody),
      };
    }
    if (existing.status === 'rejected') return this.parseStoredRejection(existing);
    return failure('OPERATION_IN_PROGRESS');
  }

  private parseStoredRejection(existing: ProcessedOperationRow): FailureResult {
    const code = existing.errorCode;
    const body = existing.responseBody;
    if (
      !code ||
      !(code in customerCollectionFailureDefinitions) ||
      !isRecord(body) ||
      body.code !== code ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Customer collection rejection is invalid.');
    }
    const definition = customerCollectionFailureDefinitions[code as CustomerCollectionFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Customer collection rejection status is invalid.');
    }
    return { ok: false, error: { ...definition, message: body.message } };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: CustomerCollectionPostingResponse,
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
    if (completed.rows.length !== 1) throw new Error('Customer collection completion failed.');
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof CustomerCollectionRejectedError)) throw error;
    const response = { code: error.result.error.code, message: error.result.error.message };
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${error.result.error.statusCode},
        response_body=${JSON.stringify(response)}::jsonb,
        error_code=${error.result.error.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) throw new Error('Customer collection rejection failed.');
    return error.result;
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts(
        store_id,operation_id,entity_type,entity_id,conflict_type,client_payload
      ) values(
        ${context.storeId}::uuid,${command.operationId}::uuid,
        ${CUSTOMER_COLLECTION_AGGREGATE},${command.operationId}::uuid,'duplicate_identity',
        jsonb_build_object('action',${CUSTOMER_COLLECTION_ACTION}::text,
          'requestHash',${command.requestHash}::text)
      )
    `);
  }
}
