import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  stores,
  supplierLedgerEntries,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
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
import { OwnerLedgerPostingRepository } from '../owner-ledger/owner-ledger-posting.repository';
import type { PostedOwnerLedgerEntry } from '../owner-ledger/owner-ledger.types';
import type {
  SupplierPaymentAllocationCommand,
  SupplierPaymentPostingCommand,
} from './supplier-payment-posting-command';
import { parseStoredSupplierPaymentPostingResponse } from './supplier-payment-posting-response';
import type {
  PostedSupplierPaymentAllocation,
  PostedSupplierPaymentPayableEntry,
  SupplierPaymentFailure,
  SupplierPaymentFailureCode,
  SupplierPaymentPostingResponse,
  SupplierPaymentPostingResult,
} from './supplier-payment-posting.types';

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

interface InvoiceTargetRow extends Record<string, unknown> {
  id: string;
  supplierId: string;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  totalMinor: string;
  payableMinor: string;
  childCount: string;
  reversalCount: string;
}

interface OpeningTargetRow extends Record<string, unknown> {
  id: string;
  supplierId: string;
  payableMinor: string;
  creditMinor: string;
  sourcePurchaseInvoiceId: string | null;
  reversalOfId: string | null;
  referenceType: string;
  referenceId: string;
  reversalCount: string;
}

interface FailureResult {
  ok: false;
  error: SupplierPaymentFailure;
}

const failureDefinitions: Readonly<Record<SupplierPaymentFailureCode, SupplierPaymentFailure>> = {
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
  SUPPLIER_NOT_FOUND: {
    code: 'SUPPLIER_NOT_FOUND',
    message: 'Supplier not found.',
    statusCode: 404,
  },
  SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING: {
    code: 'SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING',
    message: 'Supplier Payment allocation exceeds the current outstanding amount.',
    statusCode: 409,
  },
  SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT: {
    code: 'SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT',
    message: 'Supplier Payment allocation target is inconsistent.',
    statusCode: 409,
  },
  SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE: {
    code: 'SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE',
    message: 'Supplier Payment allocation target is not active.',
    statusCode: 409,
  },
  SUPPLIER_PAYMENT_TARGET_NOT_FOUND: {
    code: 'SUPPLIER_PAYMENT_TARGET_NOT_FOUND',
    message: 'Supplier Payment allocation target not found.',
    statusCode: 404,
  },
  SUPPLIER_PAYMENT_TARGET_SUPPLIER_MISMATCH: {
    code: 'SUPPLIER_PAYMENT_TARGET_SUPPLIER_MISMATCH',
    message: 'Supplier Payment allocation target belongs to a different Supplier.',
    statusCode: 409,
  },
};

class SupplierPaymentRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'SupplierPaymentRejectedError';
  }
}

function failure(code: SupplierPaymentFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

function reject(code: SupplierPaymentFailureCode): never {
  throw new SupplierPaymentRejectedError(failure(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class SupplierPaymentPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly ownerLedger: OwnerLedgerPostingRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    command: SupplierPaymentPostingCommand,
    postingDate: string,
  ): Promise<SupplierPaymentPostingResult> {
    const paymentId = deriveMoneyFactId(command.operationId, 'supplier-payment');

    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, command, paymentId);
      if (begun) return begun;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.insertPayment(savepoint, context, command, postingDate, paymentId),
        );
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  private async insertPayment(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentPostingCommand,
    postingDate: string,
    paymentId: string,
  ): Promise<SupplierPaymentPostingResponse> {
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    await this.lockSupplier(transaction, context.storeId, command.supplierId);
    await this.lockAndValidateTargets(transaction, context.storeId, command);

    if (command.paymentSource === 'money_account') {
      await this.lockAndValidateMoneyAccount(transaction, context.storeId, command.moneyAccountId);
    }

    await transaction.execute(
      sql`select set_config('app.audit_reason', 'Supplier Payment posted', true)`,
    );
    await transaction.insert(supplierPayments).values({
      id: paymentId,
      storeId: context.storeId,
      supplierId: command.supplierId,
      accountingPeriodId: posting.accountingPeriodId,
      amountMinor: command.amountMinor,
      allocatedTotalMinor: command.amountMinor,
      creditCreatedMinor: 0n,
      paymentSource: command.paymentSource,
      moneyAccountId: command.moneyAccountId,
      paymentAt: command.occurredAt,
      externalReference: command.externalReference,
      notes: command.notes,
      status: 'draft',
      deviceId: context.deviceId,
      operationId: command.operationId,
    });

    const allocations = await this.insertAllocations(transaction, context, command, paymentId);
    const payable = await this.insertPayableReduction(
      transaction,
      context,
      command,
      posting,
      paymentId,
    );
    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    let moneyMovement: PostedMoneyMovement | null = null;
    let ownerLedgerEntry: PostedOwnerLedgerEntry | null = null;

    if (command.paymentSource === 'money_account') {
      if (command.moneyAccountId === null) {
        throw new Error('Money Account payment lost its validated source.');
      }
      moneyMovement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: 'supplier-payment-money',
          accountId: command.moneyAccountId,
          amountDeltaMinor: -command.amountMinor,
          movementType: 'supplier_payment',
          referenceType: 'supplier_payment',
          referenceId: paymentId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          externalReference: command.externalReference,
          notes: command.notes,
        },
      );
    } else {
      ownerLedgerEntry = await this.ownerLedger.insertOwnerEntryWithinTransaction(
        transaction,
        context,
        {
          id: deriveMoneyFactId(command.operationId, 'supplier-payment-owner'),
          operationId: deriveMoneyFactOperationId(command.operationId, 'supplier-payment-owner'),
          entryType: 'owner_paid_supplier',
          ownerLiabilityDeltaMinor: command.amountMinor,
          equityDeltaMinor: 0n,
          moneyAccountId: null,
          accountingPeriodId: posting.accountingPeriodId,
          transactionGroupId,
          occurredAt: command.occurredAt,
          referenceType: 'supplier_payment',
          referenceId: paymentId,
        },
      );
    }

    const finalized = await transaction
      .update(supplierPayments)
      .set({
        status: 'posted',
        moneyMovementId: moneyMovement?.id ?? null,
        ownerLedgerEntryId: ownerLedgerEntry?.id ?? null,
      })
      .where(
        and(
          eq(supplierPayments.storeId, context.storeId),
          eq(supplierPayments.id, paymentId),
          eq(supplierPayments.status, 'draft'),
        ),
      )
      .returning({
        moneyMovementId: supplierPayments.moneyMovementId,
        ownerLedgerEntryId: supplierPayments.ownerLedgerEntryId,
        version: supplierPayments.version,
      });
    const payment = finalized[0];
    if (!payment) throw new Error('Supplier Payment finalization did not return a row.');

    return {
      operationId: command.operationId,
      supplierId: command.supplierId,
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      payment: {
        id: paymentId,
        paymentSource: command.paymentSource,
        moneyAccountId: command.moneyAccountId,
        amountMinor: command.amountMinor.toString(),
        allocatedTotalMinor: command.amountMinor.toString(),
        creditCreatedMinor: '0',
        paymentAt: command.occurredAt.toISOString(),
        externalReference: command.externalReference,
        notes: command.notes,
        status: 'posted',
        moneyMovementId: payment.moneyMovementId,
        ownerLedgerEntryId: payment.ownerLedgerEntryId,
        version: payment.version.toString(),
      },
      allocations,
      payable,
      moneyMovement,
      ownerLedgerEntry,
    };
  }

  private async insertAllocations(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentPostingCommand,
    paymentId: string,
  ): Promise<PostedSupplierPaymentAllocation[]> {
    const values = command.allocations.map((allocation) => ({
      id: this.allocationId(command.operationId, allocation),
      storeId: context.storeId,
      supplierPaymentId: paymentId,
      purchaseInvoiceId: allocation.targetType === 'purchase_invoice' ? allocation.targetId : null,
      openingPayableLedgerEntryId:
        allocation.targetType === 'opening_payable' ? allocation.targetId : null,
      amountMinor: allocation.amountMinor,
      supplierLedgerEntryId: null,
    }));
    const rows = await transaction.insert(supplierPaymentAllocations).values(values).returning({
      id: supplierPaymentAllocations.id,
      purchaseInvoiceId: supplierPaymentAllocations.purchaseInvoiceId,
      openingPayableLedgerEntryId: supplierPaymentAllocations.openingPayableLedgerEntryId,
      amountMinor: supplierPaymentAllocations.amountMinor,
      createdAt: supplierPaymentAllocations.createdAt,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return command.allocations.map((allocation) => {
      const id = this.allocationId(command.operationId, allocation);
      const row = byId.get(id);
      if (!row) throw new Error('Supplier Payment allocation insertion is incomplete.');
      const targetId = row.purchaseInvoiceId ?? row.openingPayableLedgerEntryId;
      if (targetId === null) throw new Error('Supplier Payment allocation target is missing.');
      return {
        id: row.id,
        targetType: allocation.targetType,
        targetId,
        amountMinor: row.amountMinor.toString(),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private async insertPayableReduction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentPostingCommand,
    posting: AccountingPeriodPostingContext,
    paymentId: string,
  ): Promise<PostedSupplierPaymentPayableEntry> {
    const rows = await transaction
      .insert(supplierLedgerEntries)
      .values({
        id: deriveMoneyFactId(command.operationId, 'supplier-payment-payable'),
        storeId: context.storeId,
        supplierId: command.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'payment',
        payableDeltaMinor: -command.amountMinor,
        creditDeltaMinor: 0n,
        sourcePurchaseInvoiceId: null,
        referenceType: 'supplier_payment',
        referenceId: paymentId,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        occurredAt: command.occurredAt,
        reason: command.notes,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(command.operationId, 'supplier-payment-payable'),
      })
      .returning({
        id: supplierLedgerEntries.id,
        payableDeltaMinor: supplierLedgerEntries.payableDeltaMinor,
        transactionGroupId: supplierLedgerEntries.transactionGroupId,
        operationId: supplierLedgerEntries.operationId,
        occurredAt: supplierLedgerEntries.occurredAt,
        createdAt: supplierLedgerEntries.createdAt,
      });
    const row = rows[0];
    if (!row) throw new Error('Supplier payable reduction insertion did not return a row.');
    return {
      id: row.id,
      payableDeltaMinor: row.payableDeltaMinor.toString(),
      transactionGroupId: row.transactionGroupId,
      operationId: row.operationId,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async lockSupplier(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
  ): Promise<void> {
    const rows = await transaction
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.storeId, storeId), eq(suppliers.id, supplierId)))
      .limit(1)
      .for('update');
    if (!rows[0]) reject('SUPPLIER_NOT_FOUND');
  }

  private async lockAndValidateTargets(
    transaction: DatabaseTransaction,
    storeId: string,
    command: SupplierPaymentPostingCommand,
  ): Promise<void> {
    for (const allocation of command.allocations) {
      if (allocation.targetType === 'purchase_invoice') {
        await this.lockAndValidateInvoice(transaction, storeId, command.supplierId, allocation);
      } else {
        await this.lockAndValidateOpening(transaction, storeId, command.supplierId, allocation);
      }
    }
  }

  private async lockAndValidateInvoice(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
    allocation: SupplierPaymentAllocationCommand,
  ): Promise<void> {
    const result = await transaction.execute<InvoiceTargetRow>(sql`
      select p.id, p.supplier_id as "supplierId", p.status,
        p.total_minor::text as "totalMinor",
        l.payable_delta_minor::text as "payableMinor",
        (select count(*)::text from ledger.purchase_invoices child
          where child.store_id=p.store_id and child.correction_of_id=p.id) as "childCount",
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=l.store_id and reversal.reversal_of_id=l.id) as "reversalCount"
      from ledger.purchase_invoices p
      inner join ledger.supplier_ledger_entries l
        on l.store_id=p.store_id and l.source_purchase_invoice_id=p.id
        and l.entry_type='supplier_invoice'
      where p.store_id=${storeId}::uuid and p.id=${allocation.targetId}::uuid
      for update of p, l
    `);
    if (result.rows.length === 0) reject('SUPPLIER_PAYMENT_TARGET_NOT_FOUND');
    if (result.rows.length !== 1) reject('SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT');
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_PAYMENT_TARGET_NOT_FOUND');
    if (row.supplierId !== supplierId) reject('SUPPLIER_PAYMENT_TARGET_SUPPLIER_MISMATCH');
    if (row.status !== 'open' || row.childCount !== '0' || row.reversalCount !== '0') {
      reject('SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE');
    }
    if (row.totalMinor !== row.payableMinor || BigInt(row.payableMinor) <= 0n) {
      reject('SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT');
    }
    await this.assertOutstanding(transaction, storeId, allocation, BigInt(row.payableMinor));
  }

  private async lockAndValidateOpening(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
    allocation: SupplierPaymentAllocationCommand,
  ): Promise<void> {
    const result = await transaction.execute<OpeningTargetRow>(sql`
      select l.id, l.supplier_id as "supplierId",
        l.payable_delta_minor::text as "payableMinor",
        l.credit_delta_minor::text as "creditMinor",
        l.source_purchase_invoice_id as "sourcePurchaseInvoiceId",
        l.reversal_of_id as "reversalOfId", l.reference_type as "referenceType",
        l.reference_id as "referenceId",
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=l.store_id and reversal.reversal_of_id=l.id) as "reversalCount"
      from ledger.supplier_ledger_entries l
      where l.store_id=${storeId}::uuid and l.id=${allocation.targetId}::uuid
        and l.entry_type='opening_balance'
      for update of l
    `);
    if (result.rows.length === 0) reject('SUPPLIER_PAYMENT_TARGET_NOT_FOUND');
    if (result.rows.length !== 1) reject('SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT');
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_PAYMENT_TARGET_NOT_FOUND');
    if (row.supplierId !== supplierId) reject('SUPPLIER_PAYMENT_TARGET_SUPPLIER_MISMATCH');
    if (row.reversalCount !== '0') reject('SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE');
    if (
      BigInt(row.payableMinor) <= 0n ||
      row.creditMinor !== '0' ||
      row.sourcePurchaseInvoiceId !== null ||
      row.reversalOfId !== null ||
      row.referenceType !== 'opening_balance' ||
      row.referenceId !== row.id
    ) {
      reject('SUPPLIER_PAYMENT_TARGET_INTEGRITY_CONFLICT');
    }
    await this.assertOutstanding(transaction, storeId, allocation, BigInt(row.payableMinor));
  }

  private async assertOutstanding(
    transaction: DatabaseTransaction,
    storeId: string,
    allocation: SupplierPaymentAllocationCommand,
    originalAmount: bigint,
  ): Promise<void> {
    const target =
      allocation.targetType === 'purchase_invoice'
        ? sql`a.purchase_invoice_id=${allocation.targetId}::uuid`
        : sql`a.opening_payable_ledger_entry_id=${allocation.targetId}::uuid`;
    const result = await transaction.execute<{ allocatedMinor: string }>(sql`
      select coalesce(sum(a.amount_minor),0)::text as "allocatedMinor"
      from ledger.supplier_payment_allocations a
      inner join ledger.supplier_payments p
        on p.store_id=a.store_id and p.id=a.supplier_payment_id
      where a.store_id=${storeId}::uuid and ${target} and p.status='posted'
    `);
    const allocated = BigInt(result.rows[0]?.allocatedMinor ?? '0');
    const outstanding = originalAmount - allocated;
    if (outstanding <= 0n) reject('SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE');
    if (allocation.amountMinor > outstanding) {
      reject('SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING');
    }
  }

  private async lockAndValidateMoneyAccount(
    transaction: DatabaseTransaction,
    storeId: string,
    moneyAccountId: string | null,
  ): Promise<void> {
    if (moneyAccountId === null) throw new Error('Money Account source is missing.');
    try {
      await this.moneyMovements.lockAndValidateAccounts(transaction, storeId, [moneyAccountId]);
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
    command: SupplierPaymentPostingCommand,
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

  private allocationId(operationId: string, allocation: SupplierPaymentAllocationCommand): string {
    return deriveMoneyFactId(
      operationId,
      `supplier-payment-allocation-${allocation.targetType}-${allocation.targetId}`,
    );
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentPostingCommand,
    paymentId: string,
  ): Promise<SupplierPaymentPostingResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (prior)
      return this.resolveProcessedOperation(transaction, context, command, paymentId, prior);

    await this.lockActiveStore(transaction, context.storeId);

    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${command.operationId}::uuid,
            ${context.deviceId}::uuid,
            'supplier_payments',
            ${paymentId}::uuid,
            'supplier_payments.post',
            ${command.requestHash}
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
      return this.resolveProcessedOperation(transaction, context, command, paymentId, concurrent);
    }

    if (claimed) return null;
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      command.operationId,
    );
    if (!existing) throw new Error('Claimed Supplier Payment operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, command, paymentId, existing);
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
    command: SupplierPaymentPostingCommand,
    paymentId: string,
    existing: ProcessedOperationRow,
  ): Promise<SupplierPaymentPostingResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== 'supplier_payments' ||
      existing.aggregateId !== paymentId ||
      existing.action !== 'supplier_payments.post' ||
      existing.requestHash !== command.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, command, paymentId);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      return {
        ok: true,
        response: parseStoredSupplierPaymentPostingResponse(existing.responseBody),
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
      !(code in failureDefinitions) ||
      !isRecord(body) ||
      body.code !== code ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Supplier Payment rejection is invalid.');
    }
    const definition = failureDefinitions[code as SupplierPaymentFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Supplier Payment rejection status is invalid.');
    }
    return { ok: false, error: { ...definition, message: body.message } };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SupplierPaymentPostingResponse,
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
      throw new Error('Supplier Payment operation completion failed.');
    }
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof SupplierPaymentRejectedError)) throw error;
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
    if (completed.rows.length !== 1) {
      throw new Error('Supplier Payment operation rejection failed.');
    }
    return error.result;
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentPostingCommand,
    paymentId: string,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts(
        store_id,operation_id,entity_type,entity_id,conflict_type,client_payload
      ) values(
        ${context.storeId}::uuid,${command.operationId}::uuid,'supplier_payments',
        ${paymentId}::uuid,'duplicate_identity',
        jsonb_build_object('action','supplier_payments.post','requestHash',${command.requestHash}::text)
      )
    `);
  }
}
