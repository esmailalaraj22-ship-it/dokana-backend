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
  moneyAccounts,
  moneyMovements,
  ownerLedgerEntries,
  stores,
  supplierLedgerEntries,
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
import { OwnerLedgerPostingRepository } from '../owner-ledger/owner-ledger-posting.repository';
import type {
  SupplierPaymentAllocationCommand,
  SupplierPaymentSource,
} from './supplier-payment-posting-command';
import {
  SupplierPaymentPostingRepository,
  SupplierPaymentRejectedError,
  supplierPaymentFailureDefinitions,
} from './supplier-payment-posting.repository';
import type { SupplierPaymentFailureCode } from './supplier-payment-posting.types';
import type { SupplierPaymentCorrectionCommand } from './supplier-payment-correction-command';
import { parseStoredSupplierPaymentCorrectionResponse } from './supplier-payment-correction-response';
import type {
  SupplierPaymentCorrectionFailure,
  SupplierPaymentCorrectionFailureCode,
  SupplierPaymentCorrectionResponse,
  SupplierPaymentCorrectionResult,
  SupplierPaymentMoneyReversal,
  SupplierPaymentOwnerReversal,
  SupplierPaymentPayableReversal,
} from './supplier-payment-correction.types';

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

interface PaymentIdentityRow extends Record<string, unknown> {
  supplierId: string;
}

interface PaymentTargetRow extends Record<string, unknown> {
  paymentId: string;
  supplierId: string;
  accountingPeriodId: string | null;
  amountMinor: string;
  allocatedTotalMinor: string;
  creditCreatedMinor: string;
  paymentSource: SupplierPaymentSource;
  moneyAccountId: string | null;
  moneyMovementId: string | null;
  ownerLedgerEntryId: string | null;
  paymentOperationId: string;
  status: 'draft' | 'posted' | 'cancelled';
  cancelledAt: Date | null;
  version: string;
  payableId: string;
  payablePeriodId: string;
  payableDeltaMinor: string;
  payableCreditDeltaMinor: string;
  payableSourceInvoiceId: string | null;
  payableReferenceType: string;
  payableReferenceId: string;
  payableTransactionGroupId: string;
  payableReversalOfId: string | null;
  payableOperationId: string;
  payableReversalCount: string;
  allocationCount: string;
  allocationTotalMinor: string;
}

interface FundingFactRow extends Record<string, unknown> {
  id: string;
  accountingPeriodId: string;
  transactionGroupId: string;
  operationId: string;
  referenceType: string | null;
  referenceId: string | null;
  reversalOfId: string | null;
  reversalCount: string;
  accountId?: string;
  movementType?: string;
  amountDeltaMinor?: string;
  entryType?: string;
  ownerLiabilityDeltaMinor?: string;
  equityDeltaMinor?: string;
  moneyAccountId?: string | null;
}

interface TargetDescriptor {
  paymentId: string;
}

const correctionFailureDefinitions = {
  SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Supplier Payment correction target is inconsistent.',
    statusCode: 409,
  },
  SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE: {
    code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE',
    message: 'Supplier Payment correction target is not the active payment.',
    statusCode: 409,
  },
  SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND: {
    code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND',
    message: 'Supplier Payment correction target not found.',
    statusCode: 404,
  },
  SUPPLIER_PAYMENT_CORRECTION_TARGET_SUPPLIER_MISMATCH: {
    code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_SUPPLIER_MISMATCH',
    message: 'Replacement Supplier must match the corrected Supplier Payment.',
    statusCode: 409,
  },
} as const satisfies Readonly<
  Record<
    Exclude<SupplierPaymentCorrectionFailureCode, SupplierPaymentFailureCode>,
    SupplierPaymentCorrectionFailure
  >
>;

const failureDefinitions: Readonly<
  Record<SupplierPaymentCorrectionFailureCode, SupplierPaymentCorrectionFailure>
> = { ...supplierPaymentFailureDefinitions, ...correctionFailureDefinitions };

class SupplierPaymentCorrectionRejectedError extends Error {
  constructor(readonly error: SupplierPaymentCorrectionFailure) {
    super(error.message);
    this.name = 'SupplierPaymentCorrectionRejectedError';
  }
}

function reject(code: SupplierPaymentCorrectionFailureCode): never {
  throw new SupplierPaymentCorrectionRejectedError(failureDefinitions[code]);
}

function failure(code: SupplierPaymentCorrectionFailureCode): SupplierPaymentCorrectionResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class SupplierPaymentCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly paymentPosting: SupplierPaymentPostingRepository,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly ownerLedger: OwnerLedgerPostingRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    command: SupplierPaymentCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<SupplierPaymentCorrectionResult> {
    const action = `supplier_payments.${command.kind}`;
    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readOperation(transaction, context.storeId, command.operationId);
      if (prior) return this.replay(transaction, context, command, action, prior);

      await this.lockActiveStore(transaction, context.storeId);
      const claimed = await this.claimOperation(transaction, context, command, action);
      if (claimed) return claimed;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.applyCorrection(savepoint, context, command, postingDate, replacementPostingDate),
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
    command: SupplierPaymentCorrectionCommand,
    postingDate: string,
    replacementPostingDate: string | null,
  ): Promise<SupplierPaymentCorrectionResponse> {
    const targetOperation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const descriptor = this.resolveTarget(targetOperation, command);
    const supplierId = await this.readTargetSupplier(
      transaction,
      context.storeId,
      descriptor.paymentId,
      command.targetOperationId,
    );
    await this.lockSupplier(transaction, context.storeId, supplierId);
    const target = await this.loadPaymentTarget(
      transaction,
      context.storeId,
      descriptor.paymentId,
      command.targetOperationId,
    );
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);

    if (command.kind === 'edit' && command.replacement.supplierId !== target.supplierId) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_SUPPLIER_MISMATCH');
    }
    const posting = await this.resolvePosting(transaction, context, command, postingDate);
    const originalAllocations = await this.readAllocations(
      transaction,
      context.storeId,
      target.paymentId,
    );
    this.assertTargetIntegrity(target, originalAllocations);
    await this.lockAffectedObligations(
      transaction,
      context.storeId,
      originalAllocations,
      command.kind === 'edit' ? command.replacement.allocations : [],
    );
    await this.lockAffectedMoneyAccounts(transaction, context.storeId, target, command);
    const funding = await this.loadAndValidateFundingFact(transaction, context.storeId, target);

    await transaction.execute(
      sql`select set_config('app.audit_reason', ${
        command.kind === 'edit' ? 'Supplier Payment edited' : 'Supplier Payment cancelled'
      }, true)`,
    );
    const reversal = await this.insertReversal(
      transaction,
      context,
      command,
      posting,
      target,
      funding,
    );
    const cancelled = await transaction
      .update(supplierPayments)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(supplierPayments.storeId, context.storeId),
          eq(supplierPayments.id, target.paymentId),
          eq(supplierPayments.status, 'posted'),
        ),
      )
      .returning({ version: supplierPayments.version });
    const cancelledRow = cancelled[0];
    if (!cancelledRow) reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE');

    const replacement =
      command.kind === 'edit'
        ? await this.paymentPosting.insertPaymentWithinTransaction(
            transaction,
            context,
            command.replacement,
            this.requireReplacementPostingDate(replacementPostingDate),
          )
        : null;

    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      intent: command.kind,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      target: {
        paymentId: target.paymentId,
        supplierId: target.supplierId,
        status: 'cancelled',
        cancelledAt: command.occurredAt.toISOString(),
        version: cancelledRow.version.toString(),
      },
      reversal,
      replacement,
    };
  }

  private resolveTarget(
    row: ProcessedOperationRow | undefined,
    command: SupplierPaymentCorrectionCommand,
  ): TargetDescriptor {
    if (!row) reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE');
    if (row.responseCode !== 201) reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');

    if (row.action === 'supplier_payments.post' && row.aggregateType === 'supplier_payments') {
      const expected = deriveMoneyFactId(command.targetOperationId, 'supplier-payment');
      if (row.aggregateId !== expected) {
        reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { paymentId: expected };
    }
    if (row.action === 'supplier_payments.edit') {
      const response = this.parseTargetResponse(row.responseBody);
      if (
        row.aggregateType !== 'supplier_payment_corrections' ||
        row.aggregateId !== command.targetOperationId ||
        response.intent !== 'edit' ||
        response.operationId !== command.targetOperationId ||
        response.replacement === null
      ) {
        reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return { paymentId: response.replacement.payment.id };
    }
    if (row.action === 'supplier_payments.cancel') {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE');
    }
    reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND');
  }

  private parseTargetResponse(value: unknown): SupplierPaymentCorrectionResponse {
    try {
      return parseStoredSupplierPaymentCorrectionResponse(value);
    } catch {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async readTargetSupplier(
    transaction: DatabaseTransaction,
    storeId: string,
    paymentId: string,
    targetOperationId: string,
  ): Promise<string> {
    const result = await transaction.execute<PaymentIdentityRow>(sql`
      select supplier_id as "supplierId"
      from ledger.supplier_payments
      where store_id=${storeId}::uuid and id=${paymentId}::uuid
        and operation_id=${targetOperationId}::uuid
    `);
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND');
    return row.supplierId;
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
    if (!rows[0]) reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND');
  }

  private async loadPaymentTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    paymentId: string,
    targetOperationId: string,
  ): Promise<PaymentTargetRow> {
    const result = await transaction.execute<PaymentTargetRow>(sql`
      select p.id as "paymentId", p.supplier_id as "supplierId",
        p.accounting_period_id as "accountingPeriodId", p.amount_minor::text as "amountMinor",
        p.allocated_total_minor::text as "allocatedTotalMinor",
        p.credit_created_minor::text as "creditCreatedMinor",
        p.payment_source as "paymentSource", p.money_account_id as "moneyAccountId",
        p.money_movement_id as "moneyMovementId",
        p.owner_ledger_entry_id as "ownerLedgerEntryId",
        p.operation_id as "paymentOperationId", p.status, p.cancelled_at as "cancelledAt",
        p.version::text as version,
        l.id as "payableId", l.accounting_period_id as "payablePeriodId",
        l.payable_delta_minor::text as "payableDeltaMinor",
        l.credit_delta_minor::text as "payableCreditDeltaMinor",
        l.source_purchase_invoice_id as "payableSourceInvoiceId",
        l.reference_type as "payableReferenceType", l.reference_id as "payableReferenceId",
        l.transaction_group_id as "payableTransactionGroupId",
        l.reversal_of_id as "payableReversalOfId", l.operation_id as "payableOperationId",
        (select count(*)::text from ledger.supplier_ledger_entries r
          where r.store_id=l.store_id and r.reversal_of_id=l.id) as "payableReversalCount",
        (select count(*)::text from ledger.supplier_payment_allocations a
          where a.store_id=p.store_id and a.supplier_payment_id=p.id) as "allocationCount",
        (select coalesce(sum(a.amount_minor),0)::text
          from ledger.supplier_payment_allocations a
          where a.store_id=p.store_id and a.supplier_payment_id=p.id) as "allocationTotalMinor"
      from ledger.supplier_payments p
      inner join ledger.supplier_ledger_entries l
        on l.store_id=p.store_id and l.entry_type='payment'
        and l.reference_type='supplier_payment' and l.reference_id=p.id
      where p.store_id=${storeId}::uuid and p.id=${paymentId}::uuid
        and p.operation_id=${targetOperationId}::uuid
      for update of p, l
    `);
    if (result.rows.length !== 1) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'posted') reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE');
    return row;
  }

  private async readAllocations(
    transaction: DatabaseTransaction,
    storeId: string,
    paymentId: string,
  ): Promise<SupplierPaymentAllocationCommand[]> {
    const result = await transaction.execute<{
      targetType: 'purchase_invoice' | 'opening_payable';
      targetId: string;
      amountMinor: string;
    }>(sql`
      select case when purchase_invoice_id is not null then 'purchase_invoice'
                  else 'opening_payable' end as "targetType",
        coalesce(purchase_invoice_id, opening_payable_ledger_entry_id) as "targetId",
        amount_minor::text as "amountMinor"
      from ledger.supplier_payment_allocations
      where store_id=${storeId}::uuid and supplier_payment_id=${paymentId}::uuid
      order by 1, 2
    `);
    return result.rows.map((row) => ({
      targetType: row.targetType,
      targetId: row.targetId,
      amountMinor: BigInt(row.amountMinor),
    }));
  }

  private assertTargetIntegrity(
    target: PaymentTargetRow,
    allocations: SupplierPaymentAllocationCommand[],
  ): void {
    const amount = BigInt(target.amountMinor);
    const expectedGroup = deriveTransactionGroupId(target.paymentOperationId);
    if (
      amount <= 0n ||
      target.accountingPeriodId === null ||
      target.allocatedTotalMinor !== target.amountMinor ||
      target.creditCreatedMinor !== '0' ||
      target.cancelledAt !== null ||
      target.payablePeriodId !== target.accountingPeriodId ||
      BigInt(target.payableDeltaMinor) !== -amount ||
      target.payableCreditDeltaMinor !== '0' ||
      target.payableSourceInvoiceId !== null ||
      target.payableReferenceType !== 'supplier_payment' ||
      target.payableReferenceId !== target.paymentId ||
      target.payableTransactionGroupId !== expectedGroup ||
      target.payableReversalOfId !== null ||
      target.payableOperationId !==
        deriveMoneyFactOperationId(target.paymentOperationId, 'supplier-payment-payable') ||
      target.payableReversalCount !== '0' ||
      target.allocationCount === '0' ||
      target.allocationCount !== allocations.length.toString() ||
      target.allocationTotalMinor !== target.amountMinor ||
      allocations.some((allocation) => allocation.amountMinor <= 0n)
    ) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (
      (target.paymentSource === 'money_account' &&
        (target.moneyAccountId === null ||
          target.moneyMovementId === null ||
          target.ownerLedgerEntryId !== null)) ||
      (target.paymentSource === 'owner_pocket' &&
        (target.moneyAccountId !== null ||
          target.moneyMovementId !== null ||
          target.ownerLedgerEntryId === null))
    ) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async lockAffectedObligations(
    transaction: DatabaseTransaction,
    storeId: string,
    original: SupplierPaymentAllocationCommand[],
    replacement: SupplierPaymentAllocationCommand[],
  ): Promise<void> {
    const targets = new Map<string, SupplierPaymentAllocationCommand>();
    for (const target of [...original, ...replacement]) {
      targets.set(`${target.targetType}:${target.targetId}`, target);
    }
    for (const target of [...targets.values()].sort((left, right) =>
      `${left.targetType}:${left.targetId}`.localeCompare(`${right.targetType}:${right.targetId}`),
    )) {
      if (target.targetType === 'purchase_invoice') {
        await transaction.execute(sql`
          select id from ledger.purchase_invoices
          where store_id=${storeId}::uuid and id=${target.targetId}::uuid
          for update
        `);
      } else {
        await transaction.execute(sql`
          select id from ledger.supplier_ledger_entries
          where store_id=${storeId}::uuid and id=${target.targetId}::uuid
          for update
        `);
      }
    }
  }

  private async lockAffectedMoneyAccounts(
    transaction: DatabaseTransaction,
    storeId: string,
    target: PaymentTargetRow,
    command: SupplierPaymentCorrectionCommand,
  ): Promise<void> {
    const ids = new Set<string>();
    if (target.moneyAccountId) ids.add(target.moneyAccountId);
    if (command.kind === 'edit' && command.replacement.moneyAccountId) {
      ids.add(command.replacement.moneyAccountId);
    }
    for (const id of [...ids].sort()) {
      await transaction
        .select({ id: moneyAccounts.id })
        .from(moneyAccounts)
        .where(and(eq(moneyAccounts.storeId, storeId), eq(moneyAccounts.id, id)))
        .limit(1)
        .for('update');
    }
  }

  private async loadAndValidateFundingFact(
    transaction: DatabaseTransaction,
    storeId: string,
    target: PaymentTargetRow,
  ): Promise<FundingFactRow> {
    const amount = BigInt(target.amountMinor);
    const expectedGroup = deriveTransactionGroupId(target.paymentOperationId);
    if (target.paymentSource === 'money_account') {
      const moneyMovementId = target.moneyMovementId;
      if (moneyMovementId === null || target.moneyAccountId === null) {
        reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const rows = await transaction
        .select({
          id: moneyMovements.id,
          accountId: moneyMovements.accountId,
          accountingPeriodId: moneyMovements.accountingPeriodId,
          movementType: moneyMovements.movementType,
          amountDeltaMinor: moneyMovements.amountDeltaMinor,
          referenceType: moneyMovements.referenceType,
          referenceId: moneyMovements.referenceId,
          transactionGroupId: moneyMovements.transactionGroupId,
          reversalOfId: moneyMovements.reversalOfId,
          operationId: moneyMovements.operationId,
        })
        .from(moneyMovements)
        .where(and(eq(moneyMovements.storeId, storeId), eq(moneyMovements.id, moneyMovementId)))
        .limit(1)
        .for('update');
      const row = rows[0];
      const reversalCount = row
        ? await this.countMoneyReversals(transaction, storeId, row.id)
        : '0';
      if (!row) {
        reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (
        row.accountId !== target.moneyAccountId ||
        row.accountingPeriodId !== target.accountingPeriodId ||
        row.movementType !== 'supplier_payment' ||
        row.amountDeltaMinor !== -amount ||
        row.referenceType !== 'supplier_payment' ||
        row.referenceId !== target.paymentId ||
        row.transactionGroupId !== expectedGroup ||
        row.reversalOfId !== null ||
        row.operationId !==
          deriveMoneyFactOperationId(target.paymentOperationId, 'supplier-payment-money') ||
        reversalCount !== '0'
      ) {
        reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return {
        ...row,
        amountDeltaMinor: row.amountDeltaMinor.toString(),
        reversalCount,
      };
    }

    const ownerLedgerEntryId = target.ownerLedgerEntryId;
    if (ownerLedgerEntryId === null) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const rows = await transaction
      .select({
        id: ownerLedgerEntries.id,
        accountingPeriodId: ownerLedgerEntries.accountingPeriodId,
        entryType: ownerLedgerEntries.entryType,
        ownerLiabilityDeltaMinor: ownerLedgerEntries.ownerLiabilityDeltaMinor,
        equityDeltaMinor: ownerLedgerEntries.equityDeltaMinor,
        moneyAccountId: ownerLedgerEntries.moneyAccountId,
        referenceType: ownerLedgerEntries.referenceType,
        referenceId: ownerLedgerEntries.referenceId,
        transactionGroupId: ownerLedgerEntries.transactionGroupId,
        reversalOfId: ownerLedgerEntries.reversalOfId,
        operationId: ownerLedgerEntries.operationId,
      })
      .from(ownerLedgerEntries)
      .where(
        and(eq(ownerLedgerEntries.storeId, storeId), eq(ownerLedgerEntries.id, ownerLedgerEntryId)),
      )
      .limit(1)
      .for('update');
    const row = rows[0];
    const reversalCount = row ? await this.countOwnerReversals(transaction, storeId, row.id) : '0';
    if (!row) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    if (
      row.accountingPeriodId !== target.accountingPeriodId ||
      row.entryType !== 'owner_paid_supplier' ||
      row.ownerLiabilityDeltaMinor !== amount ||
      row.equityDeltaMinor !== 0n ||
      row.moneyAccountId !== null ||
      row.referenceType !== 'supplier_payment' ||
      row.referenceId !== target.paymentId ||
      row.transactionGroupId !== expectedGroup ||
      row.reversalOfId !== null ||
      row.operationId !==
        deriveMoneyFactOperationId(target.paymentOperationId, 'supplier-payment-owner') ||
      reversalCount !== '0'
    ) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      ...row,
      ownerLiabilityDeltaMinor: row.ownerLiabilityDeltaMinor.toString(),
      equityDeltaMinor: row.equityDeltaMinor.toString(),
      reversalCount,
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

  private async insertReversal(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: PaymentTargetRow,
    funding: FundingFactRow,
  ): Promise<SupplierPaymentCorrectionResponse['reversal']> {
    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    const payable = await this.insertPayableReversal(
      transaction,
      context,
      command,
      posting,
      target,
      transactionGroupId,
    );
    let moneyMovement: SupplierPaymentMoneyReversal | null = null;
    let ownerLedgerEntry: SupplierPaymentOwnerReversal | null = null;

    if (target.paymentSource === 'money_account') {
      const accountId = funding.accountId;
      if (accountId === undefined) {
        reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      const movement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: 'supplier-payment-money-reversal',
          accountId,
          amountDeltaMinor: BigInt(target.amountMinor),
          movementType: 'correction',
          referenceType: 'supplier_payment_correction',
          referenceId: target.paymentId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          notes: `Supplier Payment ${command.kind}`,
          reversalOfId: funding.id,
        },
      );
      moneyMovement = { ...movement, movementType: 'correction', reversalOfId: funding.id };
    } else {
      const entry = await this.ownerLedger.insertOwnerEntryWithinTransaction(transaction, context, {
        id: deriveMoneyFactId(command.operationId, 'supplier-payment-owner-reversal'),
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          'supplier-payment-owner-reversal',
        ),
        entryType: 'correction',
        ownerLiabilityDeltaMinor: -BigInt(target.amountMinor),
        equityDeltaMinor: 0n,
        moneyAccountId: null,
        accountingPeriodId: posting.accountingPeriodId,
        transactionGroupId,
        occurredAt: command.occurredAt,
        referenceType: 'supplier_payment_correction',
        referenceId: target.paymentId,
        reversalOfId: funding.id,
      });
      ownerLedgerEntry = { ...entry, entryType: 'correction', reversalOfId: funding.id };
    }
    return { payable, moneyMovement, ownerLedgerEntry };
  }

  private async insertPayableReversal(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: PaymentTargetRow,
    transactionGroupId: string,
  ): Promise<SupplierPaymentPayableReversal> {
    const rows = await transaction
      .insert(supplierLedgerEntries)
      .values({
        id: deriveMoneyFactId(command.operationId, 'supplier-payment-payable-reversal'),
        storeId: context.storeId,
        supplierId: target.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'correction',
        payableDeltaMinor: BigInt(target.amountMinor),
        creditDeltaMinor: 0n,
        sourcePurchaseInvoiceId: null,
        referenceType: 'supplier_payment_correction',
        referenceId: target.paymentId,
        transactionGroupId,
        occurredAt: command.occurredAt,
        reversalOfId: target.payableId,
        reason: `Supplier Payment ${command.kind}`,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          'supplier-payment-payable-reversal',
        ),
      })
      .returning({
        id: supplierLedgerEntries.id,
        entryType: supplierLedgerEntries.entryType,
        payableDeltaMinor: supplierLedgerEntries.payableDeltaMinor,
        transactionGroupId: supplierLedgerEntries.transactionGroupId,
        operationId: supplierLedgerEntries.operationId,
        occurredAt: supplierLedgerEntries.occurredAt,
        createdAt: supplierLedgerEntries.createdAt,
        reversalOfId: supplierLedgerEntries.reversalOfId,
      });
    const row = rows[0];
    if (row?.entryType !== 'correction' || row.reversalOfId === null) {
      throw new Error('Supplier Payment payable reversal did not return the expected row.');
    }
    return {
      id: row.id,
      entryType: 'correction',
      payableDeltaMinor: row.payableDeltaMinor.toString(),
      transactionGroupId: row.transactionGroupId,
      operationId: row.operationId,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      reversalOfId: row.reversalOfId,
    };
  }

  private async assertTargetIsActive(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<void> {
    const result = await transaction.execute<{ superseded: boolean }>(sql`
      select exists (
        select 1 from sync.processed_operations
        where store_id=${storeId}::uuid and status='applied'
          and action in ('supplier_payments.cancel', 'supplier_payments.edit')
          and response_body ->> 'targetOperationId'=${operationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded) {
      reject('SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE');
    }
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentCorrectionCommand,
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

  private requireReplacementPostingDate(value: string | null): string {
    if (value === null) throw new Error('Replacement posting date is missing.');
    return value;
  }

  private async lockActiveStore(transaction: DatabaseTransaction, storeId: string): Promise<void> {
    const [store] = await transaction
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)
      .for('share');
    if (store?.status !== 'active') {
      throw new ForbiddenException({
        code: 'BUSINESS_WRITE_NOT_ALLOWED',
        message: 'Business writes are not allowed.',
      });
    }
  }

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierPaymentCorrectionCommand,
    action: string,
  ): Promise<SupplierPaymentCorrectionResult | null> {
    let claimed = false;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'supplier_payment_corrections',
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
    if (!existing) throw new Error('Supplier Payment correction operation claim is missing.');
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
    command: SupplierPaymentCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<SupplierPaymentCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'supplier_payment_corrections' ||
      row.aggregateId !== command.operationId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id, operation_id, entity_type, entity_id, conflict_type, client_payload)
        values(
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'supplier_payment_corrections', ${command.operationId}::uuid,
          'duplicate_identity',
          jsonb_build_object('action', ${action}::text, 'requestHash', ${command.requestHash}::text))
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) {
        throw new Error('Invalid Supplier Payment correction replay status.');
      }
      return {
        ok: true,
        response: parseStoredSupplierPaymentCorrectionResponse(row.responseBody),
      };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (
        !code ||
        !Object.hasOwn(failureDefinitions, code) ||
        row.responseCode !==
          failureDefinitions[code as SupplierPaymentCorrectionFailureCode].statusCode
      ) {
        throw new Error('Invalid Supplier Payment correction rejection status.');
      }
      return failure(code as SupplierPaymentCorrectionFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private knownFailure(error: unknown): SupplierPaymentCorrectionFailure | undefined {
    if (error instanceof SupplierPaymentCorrectionRejectedError) return error.error;
    if (error instanceof SupplierPaymentRejectedError) return error.result.error;
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SupplierPaymentCorrectionResponse,
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
      throw new Error('Supplier Payment correction operation completion failed.');
    }
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: SupplierPaymentCorrectionFailure,
  ): Promise<void> {
    const completed = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${error.statusCode},
        response_body=${JSON.stringify({ code: error.code, message: error.message })}::jsonb,
        error_code=${error.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (completed.rows.length !== 1) {
      throw new Error('Supplier Payment correction operation rejection failed.');
    }
  }
}
