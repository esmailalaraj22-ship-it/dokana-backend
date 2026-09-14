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
  customers,
  sales,
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
  partitionCustomerCollection,
  type CustomerReceivableSettlementPlanItem,
} from './customer-payment-allocation';
import type {
  CustomerCollectionPostingCommand,
  CustomerReceivableTargetType,
} from './customer-payment-posting-command';
import { parseStoredCustomerCollectionPostingResponse } from './customer-payment-posting-response';
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

interface FifoTargetReference extends Record<string, unknown> {
  targetType: CustomerReceivableTargetType;
  targetId: string;
  originId: string;
  occurredAt: string;
}

interface SaleOriginRow extends Record<string, unknown> {
  id: string;
  customerId: string;
  accountingPeriodId: string;
  receivableDeltaMinor: string;
  creditDeltaMinor: string;
  sourceSaleId: string | null;
  referenceType: string;
  referenceId: string;
  occurredAt: string;
  reversalOfId: string | null;
  reversalCount: string;
  outstandingMinor: string;
}

interface OpeningOriginRow extends SaleOriginRow {
  allocatedMinor: string;
}

interface LockedReceivableTarget extends CustomerReceivableSettlementPlanItem {
  customerId: string;
  occurredAt: Date;
  originalAmountMinor: bigint;
  outstandingMinor: bigint;
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
    await this.lockActiveCustomer(transaction, context.storeId, command.customerId);
    const settlementPlan = await this.buildSettlementPlan(transaction, context.storeId, command);
    await this.lockAndValidateMoneyAccounts(transaction, context.storeId, command);

    await transaction.execute(
      sql`select set_config('app.audit_reason', 'Customer collection posted', true)`,
    );
    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    const paymentIds = new Map<string, string>();
    for (const tender of command.tenders) {
      const id = this.paymentId(command.operationId, tender.moneyAccountId);
      paymentIds.set(tender.moneyAccountId, id);
      await transaction.insert(customerPayments).values({
        id,
        storeId: context.storeId,
        customerId: command.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        moneyAccountId: tender.moneyAccountId,
        amountMinor: tender.amountMinor,
        allocatedTotalMinor: tender.amountMinor,
        creditCreatedMinor: 0n,
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
      settlementPlan,
    );
    const movementByAccount = new Map(
      moneyMovements.map((movement) => [movement.accountId, movement]),
    );
    const payments: PostedCustomerCollectionPayment[] = [];
    for (const tender of command.tenders) {
      const paymentId = paymentIds.get(tender.moneyAccountId);
      const movement = movementByAccount.get(tender.moneyAccountId);
      if (!paymentId || !movement)
        throw new Error('Customer Payment finalization state is missing.');
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
        allocatedTotalMinor: tender.amountMinor.toString(),
        creditCreatedMinor: '0',
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
      allocationMode: command.allocationMode,
      amountMinor: command.amountMinor.toString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      payments,
      allocations,
      moneyMovements,
    };
  }

  private async insertAllocationMatrix(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: CustomerCollectionPostingCommand,
    posting: AccountingPeriodPostingContext,
    paymentIds: Map<string, string>,
    settlementPlan: CustomerReceivableSettlementPlanItem[],
  ): Promise<PostedCustomerCollectionAllocation[]> {
    const matrix = partitionCustomerCollection(command.tenders, settlementPlan);
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

  private async buildSettlementPlan(
    transaction: DatabaseTransaction,
    storeId: string,
    command: CustomerCollectionPostingCommand,
  ): Promise<CustomerReceivableSettlementPlanItem[]> {
    if (command.allocationMode === 'custom') {
      return this.buildCustomPlan(transaction, storeId, command);
    }
    const references = await this.listFifoTargetReferences(
      transaction,
      storeId,
      command.customerId,
    );
    const plan: CustomerReceivableSettlementPlanItem[] = [];
    let remaining = command.amountMinor;
    for (const reference of references) {
      if (remaining === 0n) break;
      const target = await this.lockAndReadTarget(
        transaction,
        storeId,
        reference.targetType,
        reference.targetId,
      );
      this.assertTargetCustomer(target, command.customerId);
      if (
        target.originId !== reference.originId ||
        target.occurredAt.getTime() !== new Date(reference.occurredAt).getTime()
      ) {
        reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (target.outstandingMinor <= 0n) continue;
      const amountMinor = target.outstandingMinor < remaining ? target.outstandingMinor : remaining;
      plan.push({
        targetType: target.targetType,
        targetId: target.targetId,
        originId: target.originId,
        amountMinor,
      });
      remaining -= amountMinor;
    }
    if (remaining !== 0n) reject('CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING');
    return plan;
  }

  private async buildCustomPlan(
    transaction: DatabaseTransaction,
    storeId: string,
    command: CustomerCollectionPostingCommand,
  ): Promise<CustomerReceivableSettlementPlanItem[]> {
    const plan: CustomerReceivableSettlementPlanItem[] = [];
    for (const allocation of command.allocations) {
      const target = await this.lockAndReadTarget(
        transaction,
        storeId,
        allocation.targetType,
        allocation.targetId,
      );
      this.assertTargetCustomer(target, command.customerId);
      if (target.outstandingMinor <= 0n) reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');
      if (allocation.amountMinor > target.outstandingMinor) {
        reject('CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING');
      }
      plan.push({
        targetType: target.targetType,
        targetId: target.targetId,
        originId: target.originId,
        amountMinor: allocation.amountMinor,
      });
    }
    return plan;
  }

  private async listFifoTargetReferences(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<FifoTargetReference[]> {
    const result = await transaction.execute<FifoTargetReference>(sql`
      select candidate."targetType", candidate."targetId", candidate."originId",
        candidate."occurredAt"
      from (
        select 'sale_receivable'::text as "targetType", sale.id as "targetId",
          origin.id as "originId", origin.occurred_at as "occurredAt",
          coalesce((select sum(effect.receivable_delta_minor)
            from ledger.customer_ledger_entries effect
            where effect.store_id=sale.store_id and effect.source_sale_id=sale.id),0)
            as outstanding
        from ledger.sales sale
        inner join ledger.customer_ledger_entries origin
          on origin.store_id=sale.store_id and origin.customer_id=sale.customer_id
          and origin.source_sale_id=sale.id and origin.entry_type='sale_credit'
          and origin.receivable_delta_minor > 0 and origin.credit_delta_minor=0
          and origin.reference_type='sale' and origin.reference_id=sale.id
          and origin.reversal_of_id is null
        where sale.store_id=${storeId}::uuid and sale.customer_id=${customerId}::uuid
          and sale.status='posted'
          and not exists (select 1 from ledger.customer_ledger_entries reversal
            where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
        union all
        select 'opening_receivable'::text, origin.id, origin.id, origin.occurred_at,
          origin.receivable_delta_minor - coalesce((
            select sum(allocation.amount_minor)
            from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment
              on payment.store_id=allocation.store_id
              and payment.id=allocation.customer_payment_id
            where allocation.store_id=origin.store_id
              and allocation.opening_receivable_ledger_entry_id=origin.id
              and payment.status='posted'
          ),0)
        from ledger.customer_ledger_entries origin
        where origin.store_id=${storeId}::uuid and origin.customer_id=${customerId}::uuid
          and origin.entry_type='opening_balance' and origin.receivable_delta_minor > 0
          and origin.credit_delta_minor=0 and origin.source_sale_id is null
          and origin.reference_type='customer_opening_receivable'
          and origin.reference_id=origin.id and origin.reversal_of_id is null
          and not exists (select 1 from ledger.customer_ledger_entries reversal
            where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
      ) candidate
      where candidate.outstanding > 0
      order by candidate."occurredAt" asc, candidate."originId" asc
    `);
    return result.rows;
  }

  private lockAndReadTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetType: CustomerReceivableTargetType,
    targetId: string,
  ): Promise<LockedReceivableTarget> {
    return targetType === 'sale_receivable'
      ? this.lockAndReadSaleTarget(transaction, storeId, targetId)
      : this.lockAndReadOpeningTarget(transaction, storeId, targetId);
  }

  private async lockAndReadSaleTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    saleId: string,
  ): Promise<LockedReceivableTarget> {
    const saleRows = await transaction
      .select({ id: sales.id, customerId: sales.customerId, status: sales.status })
      .from(sales)
      .where(and(eq(sales.storeId, storeId), eq(sales.id, saleId)))
      .limit(1)
      .for('update');
    const sale = saleRows[0];
    if (!sale) reject('CUSTOMER_COLLECTION_TARGET_NOT_FOUND');
    if (sale.customerId === null) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    if (sale.status !== 'posted') reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');

    const result = await transaction.execute<SaleOriginRow>(sql`
      select origin.id, origin.customer_id as "customerId",
        origin.accounting_period_id as "accountingPeriodId",
        origin.receivable_delta_minor::text as "receivableDeltaMinor",
        origin.credit_delta_minor::text as "creditDeltaMinor",
        origin.source_sale_id as "sourceSaleId", origin.reference_type as "referenceType",
        origin.reference_id as "referenceId", origin.occurred_at as "occurredAt",
        origin.reversal_of_id as "reversalOfId",
        (select count(*)::text from ledger.customer_ledger_entries reversal
          where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
          as "reversalCount",
        coalesce((select sum(effect.receivable_delta_minor)
          from ledger.customer_ledger_entries effect
          where effect.store_id=origin.store_id and effect.source_sale_id=${saleId}::uuid),0)::text
          as "outstandingMinor"
      from ledger.customer_ledger_entries origin
      where origin.store_id=${storeId}::uuid and origin.source_sale_id=${saleId}::uuid
        and origin.entry_type='sale_credit'
      order by origin.id
      for update of origin
    `);
    if (result.rows.length !== 1) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    const origin = result.rows[0];
    if (!origin) reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    if (
      origin.customerId !== sale.customerId ||
      BigInt(origin.receivableDeltaMinor) <= 0n ||
      origin.creditDeltaMinor !== '0' ||
      origin.sourceSaleId !== saleId ||
      origin.referenceType !== 'sale' ||
      origin.referenceId !== saleId ||
      origin.reversalOfId !== null
    ) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (origin.reversalCount !== '0') reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');
    const originalAmountMinor = BigInt(origin.receivableDeltaMinor);
    const outstandingMinor = BigInt(origin.outstandingMinor);
    if (outstandingMinor < 0n || outstandingMinor > originalAmountMinor) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      targetType: 'sale_receivable',
      targetId: saleId,
      originId: origin.id,
      customerId: origin.customerId,
      occurredAt: new Date(origin.occurredAt),
      originalAmountMinor,
      outstandingMinor,
      amountMinor: 0n,
    };
  }

  private async lockAndReadOpeningTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    originId: string,
  ): Promise<LockedReceivableTarget> {
    const result = await transaction.execute<OpeningOriginRow>(sql`
      select origin.id, origin.customer_id as "customerId",
        origin.accounting_period_id as "accountingPeriodId",
        origin.receivable_delta_minor::text as "receivableDeltaMinor",
        origin.credit_delta_minor::text as "creditDeltaMinor",
        origin.source_sale_id as "sourceSaleId", origin.reference_type as "referenceType",
        origin.reference_id as "referenceId", origin.occurred_at as "occurredAt",
        origin.reversal_of_id as "reversalOfId",
        (select count(*)::text from ledger.customer_ledger_entries reversal
          where reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id)
          as "reversalCount",
        coalesce((select sum(allocation.amount_minor)
          from ledger.customer_payment_allocations allocation
          inner join ledger.customer_payments payment
            on payment.store_id=allocation.store_id and payment.id=allocation.customer_payment_id
          where allocation.store_id=origin.store_id
            and allocation.opening_receivable_ledger_entry_id=origin.id
            and payment.status='posted'),0)::text as "allocatedMinor",
        (origin.receivable_delta_minor - coalesce((select sum(allocation.amount_minor)
          from ledger.customer_payment_allocations allocation
          inner join ledger.customer_payments payment
            on payment.store_id=allocation.store_id and payment.id=allocation.customer_payment_id
          where allocation.store_id=origin.store_id
            and allocation.opening_receivable_ledger_entry_id=origin.id
            and payment.status='posted'),0))::text as "outstandingMinor"
      from ledger.customer_ledger_entries origin
      where origin.store_id=${storeId}::uuid and origin.id=${originId}::uuid
      for update of origin
    `);
    const origin = result.rows[0];
    if (!origin) reject('CUSTOMER_COLLECTION_TARGET_NOT_FOUND');
    if (
      BigInt(origin.receivableDeltaMinor) <= 0n ||
      origin.creditDeltaMinor !== '0' ||
      origin.sourceSaleId !== null ||
      origin.referenceType !== 'customer_opening_receivable' ||
      origin.referenceId !== origin.id ||
      origin.reversalOfId !== null
    ) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (origin.reversalCount !== '0') reject('CUSTOMER_COLLECTION_TARGET_NOT_ACTIVE');
    const originalAmountMinor = BigInt(origin.receivableDeltaMinor);
    const outstandingMinor = BigInt(origin.outstandingMinor);
    if (outstandingMinor < 0n || outstandingMinor > originalAmountMinor) {
      reject('CUSTOMER_COLLECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      targetType: 'opening_receivable',
      targetId: origin.id,
      originId: origin.id,
      customerId: origin.customerId,
      occurredAt: new Date(origin.occurredAt),
      originalAmountMinor,
      outstandingMinor,
      amountMinor: 0n,
    };
  }

  private assertTargetCustomer(target: LockedReceivableTarget, customerId: string): void {
    if (target.customerId !== customerId) {
      reject('CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH');
    }
  }

  private async lockActiveCustomer(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ status: customers.status })
      .from(customers)
      .where(and(eq(customers.storeId, storeId), eq(customers.id, customerId)))
      .limit(1)
      .for('update');
    const customer = rows[0];
    if (!customer) reject('CUSTOMER_NOT_FOUND');
    if (customer.status !== 'active') reject('CUSTOMER_UNAVAILABLE');
  }

  private async lockAndValidateMoneyAccounts(
    transaction: DatabaseTransaction,
    storeId: string,
    command: CustomerCollectionPostingCommand,
  ): Promise<void> {
    try {
      await this.moneyMovements.lockAndValidateAccounts(
        transaction,
        storeId,
        command.tenders.map((tender) => tender.moneyAccountId),
      );
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
