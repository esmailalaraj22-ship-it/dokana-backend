import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { stores, supplierLedgerEntries, supplierReturns, suppliers } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type {
  SupplierCreditApplicationCommand,
  SupplierFinancialCorrectionCommand,
  SupplierFinancialPostingCommand,
  SupplierRefundCommand,
  SupplierReturnPostingCommand,
} from './supplier-return-command';
import {
  assertSupplierCreditApplication,
  assertSupplierCreditConsumption,
  assertSupplierReturnCapacity,
  calculateSupplierReturnWaterfall,
  deriveInvoiceOutstanding,
  SupplierReturnPolicyError,
} from './supplier-return-policy';
import {
  parseStoredSupplierFinancialCorrectionResponse,
  parseStoredSupplierFinancialMutationResponse,
  parseStoredSupplierFinancialPostingResponse,
} from './supplier-return-response';
import type {
  SupplierCreditApplicationResponse,
  SupplierFinancialCorrectionResponse,
  SupplierFinancialFailure,
  SupplierFinancialFailureCode,
  SupplierFinancialLineageResponse,
  SupplierFinancialMutationResponse,
  SupplierFinancialMutationResult,
  SupplierFinancialPostingResponse,
  SupplierFinancialReturnReadResponse,
  SupplierRefundResponse,
  SupplierReturnPostingResponse,
} from './supplier-return.types';

const AGGREGATE_POSTING = 'supplier_financial_returns';
const AGGREGATE_CORRECTION = 'supplier_financial_corrections';

const failureDefinitions: Readonly<Record<SupplierFinancialFailureCode, SupplierFinancialFailure>> =
  {
    ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: definition(
      'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
      'Accounting Period identity or boundaries are inconsistent.',
    ),
    ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: definition(
      'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
      'Accounting Period is not eligible for posting.',
    ),
    MONEY_ACCOUNT_NOT_FOUND: definition('MONEY_ACCOUNT_NOT_FOUND', 'Money Account not found.', 404),
    MONEY_ACCOUNT_UNAVAILABLE: definition(
      'MONEY_ACCOUNT_UNAVAILABLE',
      'Money Account is not available for new posting.',
    ),
    OPERATION_ID_CONFLICT: definition(
      'OPERATION_ID_CONFLICT',
      'Operation ID was reused with a different request.',
    ),
    OPERATION_IN_PROGRESS: definition(
      'OPERATION_IN_PROGRESS',
      'Operation is still being processed.',
    ),
    SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING: definition(
      'SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING',
      'Supplier Credit application exceeds Invoice outstanding.',
    ),
    SUPPLIER_CREDIT_INSUFFICIENT: definition(
      'SUPPLIER_CREDIT_INSUFFICIENT',
      'Available Supplier Credit is insufficient.',
    ),
    SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT: definition(
      'SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT',
      'Supplier financial correction target is inconsistent.',
    ),
    SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE: definition(
      'SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE',
      'Supplier financial correction target is not active.',
    ),
    SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND: definition(
      'SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND',
      'Supplier financial correction target not found.',
      404,
    ),
    SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT: definition(
      'SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT',
      'Supplier financial state is inconsistent.',
    ),
    SUPPLIER_INACTIVE: definition('SUPPLIER_INACTIVE', 'Supplier is not active.'),
    SUPPLIER_INVOICE_NOT_ACTIVE: definition(
      'SUPPLIER_INVOICE_NOT_ACTIVE',
      'Supplier Invoice is not active.',
    ),
    SUPPLIER_INVOICE_NOT_FOUND: definition(
      'SUPPLIER_INVOICE_NOT_FOUND',
      'Supplier Invoice not found.',
      404,
    ),
    SUPPLIER_INVOICE_SUPPLIER_MISMATCH: definition(
      'SUPPLIER_INVOICE_SUPPLIER_MISMATCH',
      'Supplier Invoice belongs to another Supplier.',
    ),
    SUPPLIER_NOT_FOUND: definition('SUPPLIER_NOT_FOUND', 'Supplier not found.', 404),
    SUPPLIER_RETURN_CREDIT_DEPENDENCY: definition(
      'SUPPLIER_RETURN_CREDIT_DEPENDENCY',
      'Supplier Return Credit has been consumed by later activity.',
    ),
    SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE: definition(
      'SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE',
      'Supplier Return exceeds the remaining Invoice creditable value.',
    ),
  };

interface ProcessedOperationRow extends Record<string, unknown> {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseBody: unknown;
  errorCode: string | null;
}

interface InvoiceStateRow extends Record<string, unknown> {
  id: string;
  supplierId: string;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  totalMinor: string;
  originalPayableMinor: string;
  adjustedObligationMinor: string;
  activePaymentAllocationsMinor: string;
  activeReturnTotalMinor: string;
  childCount: string;
  reversalCount: string;
}

interface SupplierLedgerInsertResult {
  id: string;
  createdAt: string;
}

interface ReturnSettlementTargetRow extends Record<string, unknown> {
  settlementType: 'reduce_payable' | 'supplier_credit';
  amountMinor: string;
  supplierLedgerEntryId: string;
  entryType: string;
  payableDeltaMinor: string;
  creditDeltaMinor: string;
  sourcePurchaseInvoiceId: string | null;
  referenceType: string;
  referenceId: string;
  operationId: string;
  transactionGroupId: string;
  reversalCount: string;
}

interface SupplierReturnTarget {
  id: string;
  supplierId: string;
  purchaseInvoiceId: string;
  amountMinor: bigint;
  reason: string;
  payable: ReturnSettlementTargetRow | null;
  credit: ReturnSettlementTargetRow | null;
}

interface LedgerOperationTargetRow extends Record<string, unknown> {
  id: string;
  supplierId: string;
  accountingPeriodId: string;
  entryType: string;
  payableDeltaMinor: string;
  creditDeltaMinor: string;
  sourcePurchaseInvoiceId: string | null;
  referenceType: string;
  referenceId: string;
  transactionGroupId: string;
  occurredAt: Date | string;
  reason: string | null;
  operationId: string;
  reversalCount: string;
}

interface RefundTarget extends LedgerOperationTargetRow {
  moneyAccountId: string;
  moneyMovementId: string;
  moneyAccountingPeriodId: string;
  moneyMovementType: string;
  moneyAmountDeltaMinor: string;
  moneyReferenceType: string;
  moneyReferenceId: string;
  moneyTransactionGroupId: string;
  moneyOperationId: string;
  moneyReversalCount: string;
}

interface MutationDescriptor {
  operationId: string;
  requestHash: string;
  aggregateType: typeof AGGREGATE_POSTING | typeof AGGREGATE_CORRECTION;
  aggregateId: string;
  action: string;
}

class SupplierFinancialRejectedError extends Error {
  constructor(readonly failure: SupplierFinancialFailure) {
    super(failure.code);
    this.name = 'SupplierFinancialRejectedError';
  }
}

function definition(
  code: SupplierFinancialFailureCode,
  message: string,
  statusCode: 404 | 409 = 409,
): SupplierFinancialFailure {
  return { code, message, statusCode };
}

function reject(code: SupplierFinancialFailureCode): never {
  throw new SupplierFinancialRejectedError(failureDefinitions[code]);
}

@Injectable()
export class SupplierReturnRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyPosting: MoneyMovementPostingRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    command: SupplierFinancialPostingCommand,
    postingDate: string,
  ): Promise<SupplierFinancialMutationResult> {
    const descriptor: MutationDescriptor = {
      operationId: command.operationId,
      requestHash: command.requestHash,
      aggregateType: AGGREGATE_POSTING,
      aggregateId: deriveMoneyFactId(command.operationId, command.family),
      action: `${command.family}.post`,
    };
    return this.executeMutation(context, descriptor, async (transaction) => {
      const posting = await this.resolvePosting(
        transaction,
        context,
        command.operationId,
        postingDate,
      );
      if (command.family === 'supplier_return') {
        return this.postReturnWithinTransaction(transaction, context, command, posting);
      }
      if (command.family === 'supplier_credit_application') {
        return this.postApplicationWithinTransaction(transaction, context, command, posting);
      }
      return this.postRefundWithinTransaction(transaction, context, command, posting);
    });
  }

  correct(
    context: TenantTransactionContext,
    command: SupplierFinancialCorrectionCommand,
    postingDate: string,
  ): Promise<SupplierFinancialMutationResult> {
    const descriptor: MutationDescriptor = {
      operationId: command.operationId,
      requestHash: command.requestHash,
      aggregateType: AGGREGATE_CORRECTION,
      aggregateId: deriveMoneyFactId(command.operationId, 'supplier_financial_correction'),
      action: `${command.family}.${command.kind}`,
    };
    return this.executeMutation(context, descriptor, async (transaction) => {
      const posting = await this.resolvePosting(
        transaction,
        context,
        command.operationId,
        postingDate,
      );
      if (command.family === 'supplier_return') {
        return this.correctReturn(transaction, context, command, posting);
      }
      if (command.family === 'supplier_credit_application') {
        return this.correctApplication(transaction, context, command, posting);
      }
      return this.correctRefund(transaction, context, command, posting);
    });
  }

  read(
    context: TenantTransactionContext,
    supplierId: string,
  ): Promise<SupplierFinancialReturnReadResponse | undefined> {
    return this.database.withTenantTransaction(context, (transaction) =>
      this.readWithinTransaction(transaction, context.storeId, supplierId),
    );
  }

  private async postReturnWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierReturnPostingCommand,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierReturnPostingResponse> {
    await this.lockSupplier(transaction, context.storeId, command.supplierId, true);
    const invoice = await this.lockInvoice(
      transaction,
      context.storeId,
      command.supplierId,
      command.purchaseInvoiceId,
    );
    this.applyPolicy(() =>
      assertSupplierReturnCapacity(
        BigInt(invoice.totalMinor),
        BigInt(invoice.activeReturnTotalMinor),
        command.amountMinor,
      ),
    );
    const outstandingMinor = this.invoiceOutstanding(invoice);
    const waterfall = calculateSupplierReturnWaterfall(command.amountMinor, outstandingMinor);
    const returnId = deriveMoneyFactId(command.operationId, command.family);

    await transaction.execute(sql`select set_config('app.audit_reason', ${command.reason}, true)`);
    // The approved Supplier Return is financial-only. Inserting the final root directly avoids
    // the legacy draft-to-post validator that requires inventory-shaped Return lines.
    const roots = await transaction
      .insert(supplierReturns)
      .values({
        id: returnId,
        storeId: context.storeId,
        supplierId: command.supplierId,
        purchaseInvoiceId: command.purchaseInvoiceId,
        accountingPeriodId: posting.accountingPeriodId,
        displayNumber: `SFR-${returnId}`,
        returnAt: command.occurredAt,
        totalMinor: command.amountMinor,
        status: 'posted',
        notes: command.reason,
        deviceId: context.deviceId,
        operationId: command.operationId,
      })
      .returning({ createdAt: supplierReturns.createdAt, version: supplierReturns.version });
    const root = roots[0];
    if (!root) throw new Error('Supplier Return insertion did not return a row.');

    let payable: SupplierLedgerInsertResult | null = null;
    let credit: SupplierLedgerInsertResult | null = null;
    if (waterfall.payableReductionMinor > 0n) {
      payable = await this.insertLedgerEntry(transaction, context, {
        operationId: command.operationId,
        discriminator: 'supplier_return_payable',
        supplierId: command.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'return',
        payableDeltaMinor: -waterfall.payableReductionMinor,
        creditDeltaMinor: 0n,
        sourcePurchaseInvoiceId: command.purchaseInvoiceId,
        referenceType: 'supplier_return',
        referenceId: returnId,
        occurredAt: command.occurredAt,
        reason: command.reason,
      });
    }
    if (waterfall.supplierCreditCreatedMinor > 0n) {
      credit = await this.insertLedgerEntry(transaction, context, {
        operationId: command.operationId,
        discriminator: 'supplier_return_credit',
        supplierId: command.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'credit_created',
        payableDeltaMinor: 0n,
        creditDeltaMinor: waterfall.supplierCreditCreatedMinor,
        sourcePurchaseInvoiceId: command.purchaseInvoiceId,
        referenceType: 'supplier_return',
        referenceId: returnId,
        occurredAt: command.occurredAt,
        reason: command.reason,
      });
    }

    if (!payable && !credit) {
      throw new Error('Supplier Return has no financial settlement.');
    }

    return {
      family: 'supplier_return',
      operationId: command.operationId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      supplierId: command.supplierId,
      posting: this.postingResponse(posting, command.occurredAt),
      return: {
        id: returnId,
        purchaseInvoiceId: command.purchaseInvoiceId,
        amountMinor: command.amountMinor.toString(),
        payableReductionMinor: waterfall.payableReductionMinor.toString(),
        supplierCreditCreatedMinor: waterfall.supplierCreditCreatedMinor.toString(),
        reason: command.reason,
        status: 'posted',
        version: root.version.toString(),
        createdAt: root.createdAt.toISOString(),
      },
      effects: {
        payableLedgerEntryId: payable?.id ?? null,
        supplierCreditLedgerEntryId: credit?.id ?? null,
      },
      inventoryEffectMinor: '0',
    };
  }

  private async postApplicationWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierCreditApplicationCommand,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierCreditApplicationResponse> {
    await this.lockSupplier(transaction, context.storeId, command.supplierId, true);
    const invoice = await this.lockInvoice(
      transaction,
      context.storeId,
      command.supplierId,
      command.purchaseInvoiceId,
    );
    const availableCreditMinor = await this.readAvailableCredit(
      transaction,
      context.storeId,
      command.supplierId,
    );
    const outstandingMinor = this.invoiceOutstanding(invoice);
    this.applyPolicy(() =>
      assertSupplierCreditApplication(availableCreditMinor, outstandingMinor, command.amountMinor),
    );
    const applicationId = deriveMoneyFactId(command.operationId, command.family);
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.notes ?? 'Supplier Credit applied'}, true)`,
    );
    const entry = await this.insertLedgerEntry(transaction, context, {
      operationId: command.operationId,
      discriminator: command.family,
      supplierId: command.supplierId,
      accountingPeriodId: posting.accountingPeriodId,
      entryType: 'credit_used',
      payableDeltaMinor: -command.amountMinor,
      creditDeltaMinor: -command.amountMinor,
      sourcePurchaseInvoiceId: command.purchaseInvoiceId,
      referenceType: command.family,
      referenceId: applicationId,
      occurredAt: command.occurredAt,
      reason: command.notes,
    });
    if (entry.id !== applicationId) {
      throw new Error('Supplier Credit Application identity is inconsistent.');
    }
    return {
      family: 'supplier_credit_application',
      operationId: command.operationId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      supplierId: command.supplierId,
      posting: this.postingResponse(posting, command.occurredAt),
      application: {
        id: applicationId,
        purchaseInvoiceId: command.purchaseInvoiceId,
        amountMinor: command.amountMinor.toString(),
        notes: command.notes,
        supplierCreditBeforeMinor: availableCreditMinor.toString(),
        supplierCreditAfterMinor: (availableCreditMinor - command.amountMinor).toString(),
        invoiceOutstandingBeforeMinor: outstandingMinor.toString(),
        invoiceOutstandingAfterMinor: (outstandingMinor - command.amountMinor).toString(),
        createdAt: entry.createdAt,
      },
    };
  }

  private async postRefundWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierRefundCommand,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierRefundResponse> {
    await this.lockSupplier(transaction, context.storeId, command.supplierId, true);
    const availableCreditMinor = await this.readAvailableCredit(
      transaction,
      context.storeId,
      command.supplierId,
    );
    this.applyPolicy(() =>
      assertSupplierCreditConsumption(availableCreditMinor, command.amountMinor),
    );
    await this.lockCurrentMoneyAccount(transaction, context.storeId, command.moneyAccountId);
    const refundId = deriveMoneyFactId(command.operationId, command.family);
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.notes ?? 'Supplier Refund received'}, true)`,
    );
    const entry = await this.insertLedgerEntry(transaction, context, {
      operationId: command.operationId,
      discriminator: command.family,
      supplierId: command.supplierId,
      accountingPeriodId: posting.accountingPeriodId,
      entryType: 'refund',
      payableDeltaMinor: 0n,
      creditDeltaMinor: -command.amountMinor,
      sourcePurchaseInvoiceId: null,
      referenceType: command.family,
      referenceId: refundId,
      occurredAt: command.occurredAt,
      reason: command.notes,
    });
    if (entry.id !== refundId) throw new Error('Supplier Refund identity is inconsistent.');
    const moneyMovement = await this.moneyPosting.insertMovementWithinTransaction(
      transaction,
      context,
      {
        commandOperationId: command.operationId,
        discriminator: 'supplier_refund_money',
        accountId: command.moneyAccountId,
        amountDeltaMinor: command.amountMinor,
        movementType: 'supplier_refund',
        referenceType: command.family,
        referenceId: refundId,
        accountingPeriodId: posting.accountingPeriodId,
        occurredAt: command.occurredAt,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        notes: command.notes,
      },
    );
    return {
      family: 'supplier_refund',
      operationId: command.operationId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      supplierId: command.supplierId,
      posting: this.postingResponse(posting, command.occurredAt),
      refund: {
        id: refundId,
        moneyAccountId: command.moneyAccountId,
        amountMinor: command.amountMinor.toString(),
        notes: command.notes,
        supplierCreditBeforeMinor: availableCreditMinor.toString(),
        supplierCreditAfterMinor: (availableCreditMinor - command.amountMinor).toString(),
        moneyMovement,
        createdAt: entry.createdAt,
      },
    };
  }

  private async correctReturn(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: Extract<SupplierFinancialCorrectionCommand, { family: 'supplier_return' }>,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierFinancialCorrectionResponse> {
    const identity = await this.findReturnIdentity(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    if (!identity) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    await this.lockSupplier(transaction, context.storeId, identity.supplierId, false);
    await this.lockInvoice(
      transaction,
      context.storeId,
      identity.supplierId,
      identity.purchaseInvoiceId,
    );
    const target = await this.loadReturnTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const creditCreatedMinor = target.credit ? BigInt(target.credit.amountMinor) : 0n;
    if (creditCreatedMinor > 0n) {
      const availableCreditMinor = await this.readAvailableCredit(
        transaction,
        context.storeId,
        target.supplierId,
      );
      if (availableCreditMinor < creditCreatedMinor) {
        reject('SUPPLIER_RETURN_CREDIT_DEPENDENCY');
      }
    }
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.correctionReason}, true)`,
    );
    const reversalIds: string[] = [];
    if (target.payable) {
      const reversal = await this.insertLedgerEntry(transaction, context, {
        operationId: command.operationId,
        discriminator: 'supplier_return_payable_reversal',
        supplierId: target.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'correction',
        payableDeltaMinor: -BigInt(target.payable.payableDeltaMinor),
        creditDeltaMinor: 0n,
        sourcePurchaseInvoiceId: target.purchaseInvoiceId,
        referenceType: 'supplier_return_correction',
        referenceId: target.id,
        occurredAt: command.occurredAt,
        reversalOfId: target.payable.supplierLedgerEntryId,
        reason: command.correctionReason,
      });
      reversalIds.push(reversal.id);
    }
    if (target.credit) {
      const reversal = await this.insertLedgerEntry(transaction, context, {
        operationId: command.operationId,
        discriminator: 'supplier_return_credit_reversal',
        supplierId: target.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'correction',
        payableDeltaMinor: 0n,
        creditDeltaMinor: -BigInt(target.credit.creditDeltaMinor),
        sourcePurchaseInvoiceId: target.purchaseInvoiceId,
        referenceType: 'supplier_return_correction',
        referenceId: target.id,
        occurredAt: command.occurredAt,
        reversalOfId: target.credit.supplierLedgerEntryId,
        reason: command.correctionReason,
      });
      reversalIds.push(reversal.id);
    }
    const cancelled = await transaction
      .update(supplierReturns)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(supplierReturns.storeId, context.storeId),
          eq(supplierReturns.id, target.id),
          eq(supplierReturns.status, 'posted'),
        ),
      )
      .returning({ id: supplierReturns.id });
    if (!cancelled[0]) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');

    let replacement: SupplierFinancialPostingResponse | null = null;
    if (command.kind === 'replace') {
      replacement = await this.postReturnWithinTransaction(
        transaction,
        context,
        {
          family: 'supplier_return',
          operationId: command.operationId,
          supplierId: target.supplierId,
          purchaseInvoiceId: target.purchaseInvoiceId,
          amountMinor: command.replacement.amountMinor,
          occurredAt: command.occurredAt,
          reason: command.replacement.reason,
          requestHash: command.requestHash,
        },
        posting,
      );
    }
    return this.correctionResponse(command, target.supplierId, target.id, posting, {
      supplierLedgerEntryIds: reversalIds,
      moneyMovement: null,
      replacement,
      status: 'cancelled',
    });
  }

  private async correctApplication(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: Extract<SupplierFinancialCorrectionCommand, { family: 'supplier_credit_application' }>,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierFinancialCorrectionResponse> {
    const applicationId = deriveMoneyFactId(
      command.targetOperationId,
      'supplier_credit_application',
    );
    const identity = await this.findLedgerTargetIdentity(
      transaction,
      context.storeId,
      applicationId,
    );
    if (!identity?.sourcePurchaseInvoiceId) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    }
    await this.lockSupplier(transaction, context.storeId, identity.supplierId, false);
    await this.lockInvoice(
      transaction,
      context.storeId,
      identity.supplierId,
      identity.sourcePurchaseInvoiceId,
    );
    const target = await this.loadApplicationTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const amountMinor = -BigInt(target.creditDeltaMinor);
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.correctionReason}, true)`,
    );
    const reversal = await this.insertLedgerEntry(transaction, context, {
      operationId: command.operationId,
      discriminator: 'supplier_credit_application_reversal',
      supplierId: target.supplierId,
      accountingPeriodId: posting.accountingPeriodId,
      entryType: 'correction',
      payableDeltaMinor: amountMinor,
      creditDeltaMinor: amountMinor,
      sourcePurchaseInvoiceId: target.sourcePurchaseInvoiceId,
      referenceType: 'supplier_credit_application_correction',
      referenceId: target.id,
      occurredAt: command.occurredAt,
      reversalOfId: target.id,
      reason: command.correctionReason,
    });

    let replacement: SupplierFinancialPostingResponse | null = null;
    if (command.kind === 'replace') {
      replacement = await this.postApplicationWithinTransaction(
        transaction,
        context,
        {
          family: 'supplier_credit_application',
          operationId: command.operationId,
          supplierId: target.supplierId,
          purchaseInvoiceId: command.replacement.purchaseInvoiceId,
          amountMinor: command.replacement.amountMinor,
          occurredAt: command.occurredAt,
          notes: command.replacement.notes,
          requestHash: command.requestHash,
        },
        posting,
      );
    }
    return this.correctionResponse(command, target.supplierId, target.id, posting, {
      supplierLedgerEntryIds: [reversal.id],
      moneyMovement: null,
      replacement,
      status: 'reversed',
    });
  }

  private async correctRefund(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: Extract<SupplierFinancialCorrectionCommand, { family: 'supplier_refund' }>,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierFinancialCorrectionResponse> {
    const refundId = deriveMoneyFactId(command.targetOperationId, 'supplier_refund');
    const identity = await this.findLedgerTargetIdentity(transaction, context.storeId, refundId);
    if (!identity) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    await this.lockSupplier(transaction, context.storeId, identity.supplierId, false);
    const target = await this.loadRefundTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const amountMinor = -BigInt(target.creditDeltaMinor);
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.correctionReason}, true)`,
    );
    const creditReversal = await this.insertLedgerEntry(transaction, context, {
      operationId: command.operationId,
      discriminator: 'supplier_refund_credit_reversal',
      supplierId: target.supplierId,
      accountingPeriodId: posting.accountingPeriodId,
      entryType: 'correction',
      payableDeltaMinor: 0n,
      creditDeltaMinor: amountMinor,
      sourcePurchaseInvoiceId: null,
      referenceType: 'supplier_refund_correction',
      referenceId: target.id,
      occurredAt: command.occurredAt,
      reversalOfId: target.id,
      reason: command.correctionReason,
    });
    const moneyReversal = await this.moneyPosting.insertMovementWithinTransaction(
      transaction,
      context,
      {
        commandOperationId: command.operationId,
        discriminator: 'supplier_refund_money_reversal',
        accountId: target.moneyAccountId,
        amountDeltaMinor: -BigInt(target.moneyAmountDeltaMinor),
        movementType: 'correction',
        referenceType: 'supplier_refund_correction',
        referenceId: target.id,
        accountingPeriodId: posting.accountingPeriodId,
        occurredAt: command.occurredAt,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        notes: command.correctionReason,
        reversalOfId: target.moneyMovementId,
      },
    );

    let replacement: SupplierFinancialPostingResponse | null = null;
    if (command.kind === 'replace') {
      replacement = await this.postRefundWithinTransaction(
        transaction,
        context,
        {
          family: 'supplier_refund',
          operationId: command.operationId,
          supplierId: target.supplierId,
          moneyAccountId: command.replacement.moneyAccountId,
          amountMinor: command.replacement.amountMinor,
          occurredAt: command.occurredAt,
          notes: command.replacement.notes,
          requestHash: command.requestHash,
        },
        posting,
      );
    }
    return this.correctionResponse(command, target.supplierId, target.id, posting, {
      supplierLedgerEntryIds: [creditReversal.id],
      moneyMovement: moneyReversal,
      replacement,
      status: 'reversed',
    });
  }

  private correctionResponse(
    command: SupplierFinancialCorrectionCommand,
    supplierId: string,
    targetId: string,
    posting: AccountingPeriodPostingContext,
    result: {
      supplierLedgerEntryIds: string[];
      moneyMovement: PostedMoneyMovement | null;
      replacement: SupplierFinancialPostingResponse | null;
      status: 'cancelled' | 'reversed';
    },
  ): SupplierFinancialCorrectionResponse {
    return {
      family: command.family,
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      intent: command.kind,
      correctionReason: command.correctionReason,
      supplierId,
      posting: this.postingResponse(posting, command.occurredAt),
      target: { id: targetId, status: result.status },
      reversal: {
        supplierLedgerEntryIds: result.supplierLedgerEntryIds,
        moneyMovement: result.moneyMovement,
      },
      replacement: result.replacement,
    };
  }

  private async findReturnIdentity(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
  ): Promise<{ supplierId: string; purchaseInvoiceId: string } | undefined> {
    const result = await transaction.execute<{
      supplierId: string;
      purchaseInvoiceId: string | null;
    }>(sql`
      select supplier_id as "supplierId", purchase_invoice_id as "purchaseInvoiceId"
      from ledger.supplier_returns
      where store_id=${storeId}::uuid and operation_id=${targetOperationId}::uuid
      limit 1
    `);
    const row = result.rows[0];
    if (!row?.purchaseInvoiceId) return undefined;
    return { supplierId: row.supplierId, purchaseInvoiceId: row.purchaseInvoiceId };
  }

  private async loadReturnTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
  ): Promise<SupplierReturnTarget> {
    const rootResult = await transaction.execute<{
      id: string;
      supplierId: string;
      purchaseInvoiceId: string | null;
      totalMinor: string;
      status: string;
      notes: string | null;
      itemCount: string;
    }>(sql`
      select r.id, r.supplier_id as "supplierId",
        r.purchase_invoice_id as "purchaseInvoiceId", r.total_minor::text as "totalMinor",
        r.status, r.notes,
        (select count(*)::text from ledger.supplier_return_items item
          where item.store_id=r.store_id and item.supplier_return_id=r.id) as "itemCount"
      from ledger.supplier_returns r
      where r.store_id=${storeId}::uuid and r.operation_id=${targetOperationId}::uuid
      for update of r
    `);
    if (rootResult.rows.length === 0) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    if (rootResult.rows.length !== 1) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const root = rootResult.rows[0];
    if (!root) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    if (root.status !== 'posted') reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    if (
      !root.purchaseInvoiceId ||
      BigInt(root.totalMinor) <= 0n ||
      !root.notes ||
      root.itemCount !== '0'
    ) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const settlementResult = await transaction.execute<ReturnSettlementTargetRow>(sql`
      select case entry.entry_type
          when 'return' then 'reduce_payable'
          when 'credit_created' then 'supplier_credit'
        end as "settlementType",
        case entry.entry_type
          when 'return' then (-entry.payable_delta_minor)::text
          when 'credit_created' then entry.credit_delta_minor::text
        end as "amountMinor",
        entry.id as "supplierLedgerEntryId",
        entry.entry_type as "entryType",
        entry.payable_delta_minor::text as "payableDeltaMinor",
        entry.credit_delta_minor::text as "creditDeltaMinor",
        entry.source_purchase_invoice_id as "sourcePurchaseInvoiceId",
        entry.reference_type as "referenceType", entry.reference_id as "referenceId",
        entry.operation_id as "operationId",
        entry.transaction_group_id as "transactionGroupId",
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=entry.store_id and reversal.reversal_of_id=entry.id) as "reversalCount"
      from ledger.supplier_ledger_entries entry
      where entry.store_id=${storeId}::uuid
        and entry.reference_type='supplier_return'
        and entry.reference_id=${root.id}::uuid
        and entry.entry_type in ('return','credit_created')
      order by entry.entry_type
    `);
    if (settlementResult.rows.length < 1 || settlementResult.rows.length > 2) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    let payable: ReturnSettlementTargetRow | null = null;
    let credit: ReturnSettlementTargetRow | null = null;
    let total = 0n;
    for (const row of settlementResult.rows) {
      const amount = BigInt(row.amountMinor);
      total += amount;
      if (
        amount <= 0n ||
        row.sourcePurchaseInvoiceId !== root.purchaseInvoiceId ||
        row.referenceType !== 'supplier_return' ||
        row.referenceId !== root.id ||
        row.reversalCount !== '0'
      ) {
        reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      if (row.settlementType === 'reduce_payable') {
        if (
          payable ||
          row.entryType !== 'return' ||
          BigInt(row.payableDeltaMinor) !== -amount ||
          row.creditDeltaMinor !== '0' ||
          row.supplierLedgerEntryId !==
            deriveMoneyFactId(targetOperationId, 'supplier_return_payable') ||
          row.operationId !==
            deriveMoneyFactOperationId(targetOperationId, 'supplier_return_payable') ||
          row.transactionGroupId !== deriveTransactionGroupId(targetOperationId)
        ) {
          reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
        payable = row;
      } else if (
        !credit &&
        row.entryType === 'credit_created' &&
        row.payableDeltaMinor === '0' &&
        BigInt(row.creditDeltaMinor) === amount &&
        row.supplierLedgerEntryId ===
          deriveMoneyFactId(targetOperationId, 'supplier_return_credit') &&
        row.operationId ===
          deriveMoneyFactOperationId(targetOperationId, 'supplier_return_credit') &&
        row.transactionGroupId === deriveTransactionGroupId(targetOperationId)
      ) {
        credit = row;
      } else {
        reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
    }
    if (total !== BigInt(root.totalMinor)) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return {
      id: root.id,
      supplierId: root.supplierId,
      purchaseInvoiceId: root.purchaseInvoiceId,
      amountMinor: BigInt(root.totalMinor),
      reason: root.notes,
      payable,
      credit,
    };
  }

  private async findLedgerTargetIdentity(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<{ supplierId: string; sourcePurchaseInvoiceId: string | null } | undefined> {
    const result = await transaction.execute<{
      supplierId: string;
      sourcePurchaseInvoiceId: string | null;
    }>(sql`
      select supplier_id as "supplierId", source_purchase_invoice_id as "sourcePurchaseInvoiceId"
      from ledger.supplier_ledger_entries
      where store_id=${storeId}::uuid and id=${id}::uuid
      limit 1
    `);
    return result.rows[0];
  }

  private async loadApplicationTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
  ): Promise<LedgerOperationTargetRow> {
    const id = deriveMoneyFactId(targetOperationId, 'supplier_credit_application');
    const row = await this.loadLedgerOperationTarget(transaction, storeId, id);
    if (!row) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    if (row.reversalCount !== '0') reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    const amount = -BigInt(row.creditDeltaMinor);
    if (
      row.entryType !== 'credit_used' ||
      amount <= 0n ||
      BigInt(row.payableDeltaMinor) !== -amount ||
      !row.sourcePurchaseInvoiceId ||
      row.referenceType !== 'supplier_credit_application' ||
      row.referenceId !== row.id ||
      row.transactionGroupId !== deriveTransactionGroupId(targetOperationId) ||
      row.operationId !==
        deriveMoneyFactOperationId(targetOperationId, 'supplier_credit_application')
    ) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return row;
  }

  private async loadRefundTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
  ): Promise<RefundTarget> {
    const id = deriveMoneyFactId(targetOperationId, 'supplier_refund');
    const result = await transaction.execute<RefundTarget>(sql`
      select entry.id, entry.supplier_id as "supplierId",
        entry.accounting_period_id as "accountingPeriodId", entry.entry_type as "entryType",
        entry.payable_delta_minor::text as "payableDeltaMinor",
        entry.credit_delta_minor::text as "creditDeltaMinor",
        entry.source_purchase_invoice_id as "sourcePurchaseInvoiceId",
        entry.reference_type as "referenceType", entry.reference_id as "referenceId",
        entry.transaction_group_id as "transactionGroupId", entry.occurred_at as "occurredAt",
        entry.reason, entry.operation_id as "operationId",
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=entry.store_id and reversal.reversal_of_id=entry.id) as "reversalCount",
        movement.account_id as "moneyAccountId", movement.id as "moneyMovementId",
        movement.accounting_period_id as "moneyAccountingPeriodId",
        movement.movement_type as "moneyMovementType",
        movement.amount_delta_minor::text as "moneyAmountDeltaMinor",
        movement.reference_type as "moneyReferenceType",
        movement.reference_id as "moneyReferenceId",
        movement.transaction_group_id as "moneyTransactionGroupId",
        movement.operation_id as "moneyOperationId",
        (select count(*)::text from ledger.money_movements reversal
          where reversal.store_id=movement.store_id and reversal.reversal_of_id=movement.id) as "moneyReversalCount"
      from ledger.supplier_ledger_entries entry
      inner join ledger.money_movements movement
        on movement.store_id=entry.store_id
        and movement.reference_type='supplier_refund'
        and movement.reference_id=entry.id
      where entry.store_id=${storeId}::uuid and entry.id=${id}::uuid
    `);
    if (result.rows.length === 0) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    if (result.rows.length !== 1) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND');
    if (row.reversalCount !== '0' || row.moneyReversalCount !== '0') {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE');
    }
    const amount = -BigInt(row.creditDeltaMinor);
    if (
      row.entryType !== 'refund' ||
      amount <= 0n ||
      row.payableDeltaMinor !== '0' ||
      row.sourcePurchaseInvoiceId !== null ||
      row.referenceType !== 'supplier_refund' ||
      row.referenceId !== row.id ||
      row.transactionGroupId !== deriveTransactionGroupId(targetOperationId) ||
      row.operationId !== deriveMoneyFactOperationId(targetOperationId, 'supplier_refund') ||
      row.moneyAccountingPeriodId !== row.accountingPeriodId ||
      row.moneyMovementType !== 'supplier_refund' ||
      BigInt(row.moneyAmountDeltaMinor) !== amount ||
      row.moneyReferenceType !== 'supplier_refund' ||
      row.moneyReferenceId !== row.id ||
      row.moneyTransactionGroupId !== row.transactionGroupId ||
      row.moneyOperationId !==
        deriveMoneyFactOperationId(targetOperationId, 'supplier_refund_money')
    ) {
      reject('SUPPLIER_FINANCIAL_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return row;
  }

  private async loadLedgerOperationTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    id: string,
  ): Promise<LedgerOperationTargetRow | undefined> {
    const result = await transaction.execute<LedgerOperationTargetRow>(sql`
      select entry.id, entry.supplier_id as "supplierId",
        entry.accounting_period_id as "accountingPeriodId", entry.entry_type as "entryType",
        entry.payable_delta_minor::text as "payableDeltaMinor",
        entry.credit_delta_minor::text as "creditDeltaMinor",
        entry.source_purchase_invoice_id as "sourcePurchaseInvoiceId",
        entry.reference_type as "referenceType", entry.reference_id as "referenceId",
        entry.transaction_group_id as "transactionGroupId", entry.occurred_at as "occurredAt",
        entry.reason, entry.operation_id as "operationId",
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=entry.store_id and reversal.reversal_of_id=entry.id) as "reversalCount"
      from ledger.supplier_ledger_entries entry
      where entry.store_id=${storeId}::uuid and entry.id=${id}::uuid
    `);
    return result.rows[0];
  }

  private async lockSupplier(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
    requireActive: boolean,
  ): Promise<void> {
    const rows = await transaction
      .select({ id: suppliers.id, status: suppliers.status })
      .from(suppliers)
      .where(and(eq(suppliers.storeId, storeId), eq(suppliers.id, supplierId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) reject('SUPPLIER_NOT_FOUND');
    if (requireActive && row.status !== 'active') reject('SUPPLIER_INACTIVE');
  }

  private async lockInvoice(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
    purchaseInvoiceId: string,
  ): Promise<InvoiceStateRow> {
    const result = await transaction.execute<InvoiceStateRow>(sql`
      select invoice.id, invoice.supplier_id as "supplierId", invoice.status,
        invoice.total_minor::text as "totalMinor",
        original.payable_delta_minor::text as "originalPayableMinor",
        coalesce((select sum(entry.payable_delta_minor)
          from ledger.supplier_ledger_entries entry
          where entry.store_id=invoice.store_id
            and entry.source_purchase_invoice_id=invoice.id),0)::text as "adjustedObligationMinor",
        coalesce((select sum(allocation.amount_minor)
          from ledger.supplier_payment_allocations allocation
          inner join ledger.supplier_payments payment
            on payment.store_id=allocation.store_id and payment.id=allocation.supplier_payment_id
          where allocation.store_id=invoice.store_id
            and allocation.purchase_invoice_id=invoice.id
            and payment.status='posted'),0)::text as "activePaymentAllocationsMinor",
        coalesce((select sum(financial_return.total_minor)
          from ledger.supplier_returns financial_return
          where financial_return.store_id=invoice.store_id
            and financial_return.purchase_invoice_id=invoice.id
            and financial_return.status='posted'),0)::text as "activeReturnTotalMinor",
        (select count(*)::text from ledger.purchase_invoices child
          where child.store_id=invoice.store_id and child.correction_of_id=invoice.id) as "childCount",
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=original.store_id and reversal.reversal_of_id=original.id) as "reversalCount"
      from ledger.purchase_invoices invoice
      inner join ledger.supplier_ledger_entries original
        on original.store_id=invoice.store_id
        and original.source_purchase_invoice_id=invoice.id
        and original.entry_type='supplier_invoice'
      where invoice.store_id=${storeId}::uuid and invoice.id=${purchaseInvoiceId}::uuid
      for update of invoice, original
    `);
    if (result.rows.length === 0) reject('SUPPLIER_INVOICE_NOT_FOUND');
    if (result.rows.length !== 1) reject('SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT');
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_INVOICE_NOT_FOUND');
    if (row.supplierId !== supplierId) reject('SUPPLIER_INVOICE_SUPPLIER_MISMATCH');
    if (row.status !== 'open' || row.childCount !== '0' || row.reversalCount !== '0') {
      reject('SUPPLIER_INVOICE_NOT_ACTIVE');
    }
    if (BigInt(row.totalMinor) <= 0n || row.totalMinor !== row.originalPayableMinor) {
      reject('SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT');
    }
    this.invoiceOutstanding(row);
    return row;
  }

  private invoiceOutstanding(invoice: InvoiceStateRow): bigint {
    try {
      return deriveInvoiceOutstanding(
        BigInt(invoice.adjustedObligationMinor),
        BigInt(invoice.activePaymentAllocationsMinor),
      );
    } catch (error) {
      if (error instanceof SupplierReturnPolicyError) {
        reject('SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT');
      }
      throw error;
    }
  }

  private async readAvailableCredit(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
  ): Promise<bigint> {
    const result = await transaction.execute<{ availableMinor: string }>(sql`
      select coalesce(sum(credit_delta_minor),0)::text as "availableMinor"
      from ledger.supplier_ledger_entries
      where store_id=${storeId}::uuid and supplier_id=${supplierId}::uuid
    `);
    const available = BigInt(result.rows[0]?.availableMinor ?? '0');
    if (available < 0n) reject('SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT');
    return available;
  }

  private async insertLedgerEntry(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    spec: {
      operationId: string;
      discriminator: string;
      supplierId: string;
      accountingPeriodId: string;
      entryType: 'return' | 'credit_created' | 'credit_used' | 'refund' | 'correction';
      payableDeltaMinor: bigint;
      creditDeltaMinor: bigint;
      sourcePurchaseInvoiceId: string | null;
      referenceType: string;
      referenceId: string;
      occurredAt: Date;
      reversalOfId?: string | null;
      reason: string | null;
    },
  ): Promise<SupplierLedgerInsertResult> {
    const rows = await transaction
      .insert(supplierLedgerEntries)
      .values({
        id: deriveMoneyFactId(spec.operationId, spec.discriminator),
        storeId: context.storeId,
        supplierId: spec.supplierId,
        accountingPeriodId: spec.accountingPeriodId,
        entryType: spec.entryType,
        payableDeltaMinor: spec.payableDeltaMinor,
        creditDeltaMinor: spec.creditDeltaMinor,
        sourcePurchaseInvoiceId: spec.sourcePurchaseInvoiceId,
        referenceType: spec.referenceType,
        referenceId: spec.referenceId,
        transactionGroupId: deriveTransactionGroupId(spec.operationId),
        occurredAt: spec.occurredAt,
        reversalOfId: spec.reversalOfId ?? null,
        reason: spec.reason,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(spec.operationId, spec.discriminator),
      })
      .returning({ id: supplierLedgerEntries.id, createdAt: supplierLedgerEntries.createdAt });
    const row = rows[0];
    if (!row) throw new Error('Supplier ledger insertion did not return a row.');
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  }

  private async lockCurrentMoneyAccount(
    transaction: DatabaseTransaction,
    storeId: string,
    accountId: string,
  ): Promise<void> {
    try {
      await this.moneyPosting.lockAndValidateAccounts(transaction, storeId, [accountId]);
    } catch (error) {
      if (error instanceof HttpException) {
        const response = error.getResponse();
        if (this.errorCode(response) === 'MONEY_ACCOUNT_NOT_FOUND')
          reject('MONEY_ACCOUNT_NOT_FOUND');
        if (this.errorCode(response) === 'MONEY_ACCOUNT_UNAVAILABLE') {
          reject('MONEY_ACCOUNT_UNAVAILABLE');
        }
      }
      throw error;
    }
  }

  private errorCode(value: string | object): string | null {
    if (typeof value === 'string' || !('code' in value)) return null;
    return typeof value.code === 'string' ? value.code : null;
  }

  private applyPolicy(work: () => void): void {
    try {
      work();
    } catch (error) {
      if (!(error instanceof SupplierReturnPolicyError)) throw error;
      if (error.code === 'SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE') {
        reject('SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE');
      }
      if (error.code === 'SUPPLIER_CREDIT_INSUFFICIENT') {
        reject('SUPPLIER_CREDIT_INSUFFICIENT');
      }
      if (error.code === 'SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING') {
        reject('SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING');
      }
      reject('SUPPLIER_FINANCIAL_STATE_INTEGRITY_CONFLICT');
    }
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

  private postingResponse(
    posting: AccountingPeriodPostingContext,
    occurredAt: Date,
  ): SupplierReturnPostingResponse['posting'] {
    return {
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      occurredAt: occurredAt.toISOString(),
    };
  }

  private executeMutation(
    context: TenantTransactionContext,
    descriptor: MutationDescriptor,
    work: (transaction: DatabaseTransaction) => Promise<SupplierFinancialMutationResponse>,
  ): Promise<SupplierFinancialMutationResult> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const prior = await this.readOperation(transaction, context.storeId, descriptor.operationId);
      if (prior) return this.replayOperation(transaction, context, descriptor, prior);

      await this.lockActiveStore(transaction, context.storeId);
      const claimed = await this.claimOperation(transaction, context, descriptor);
      if (claimed) return claimed;

      try {
        const response = await transaction.transaction(work);
        await this.completeApplied(transaction, context.storeId, descriptor.operationId, response);
        return { ok: true, response };
      } catch (error) {
        if (!(error instanceof SupplierFinancialRejectedError)) throw error;
        await this.completeRejected(
          transaction,
          context.storeId,
          descriptor.operationId,
          error.failure,
        );
        return { ok: false, error: error.failure };
      }
    });
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
    await this.database.assertBusinessWriteAllowed(transaction, storeId);
  }

  private async claimOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    descriptor: MutationDescriptor,
  ): Promise<SupplierFinancialMutationResult | null> {
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${descriptor.operationId}::uuid,
            ${context.deviceId}::uuid, ${descriptor.aggregateType},
            ${descriptor.aggregateId}::uuid, ${descriptor.action}, ${descriptor.requestHash}
          ) as claimed
        `),
      );
      if (result.rows[0]?.claimed === true) return null;
    } catch (error) {
      if (this.postgresqlErrorCode(error) !== '23505') throw error;
    }
    const existing = await this.readOperation(transaction, context.storeId, descriptor.operationId);
    if (!existing) throw new Error('Claimed Supplier financial operation could not be read.');
    return this.replayOperation(transaction, context, descriptor, existing);
  }

  private async replayOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    descriptor: MutationDescriptor,
    existing: ProcessedOperationRow,
  ): Promise<SupplierFinancialMutationResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== descriptor.aggregateType ||
      existing.aggregateId !== descriptor.aggregateId ||
      existing.action !== descriptor.action ||
      existing.requestHash !== descriptor.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, descriptor);
      return { ok: false, error: failureDefinitions.OPERATION_ID_CONFLICT };
    }
    if (existing.status === 'processing') {
      return { ok: false, error: failureDefinitions.OPERATION_IN_PROGRESS };
    }
    if (existing.status === 'rejected') {
      const code = existing.errorCode;
      if (!code || !(code in failureDefinitions)) {
        throw new Error('Stored Supplier financial rejection is invalid.');
      }
      return {
        ok: false,
        error: failureDefinitions[code as SupplierFinancialFailureCode],
      };
    }
    try {
      const response =
        descriptor.aggregateType === AGGREGATE_CORRECTION
          ? parseStoredSupplierFinancialCorrectionResponse(existing.responseBody)
          : parseStoredSupplierFinancialPostingResponse(existing.responseBody);
      return { ok: true, response };
    } catch {
      throw new Error('Stored Supplier financial response is invalid.');
    }
  }

  private async readOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select device_id as "deviceId", aggregate_type as "aggregateType",
        aggregate_id as "aggregateId", action, request_hash as "requestHash",
        status, response_body as "responseBody", error_code as "errorCode"
      from sync.processed_operations
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SupplierFinancialMutationResponse,
  ): Promise<void> {
    const parsed = parseStoredSupplierFinancialMutationResponse(response);
    const result = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied', response_code=201,
        response_body=${JSON.stringify(parsed)}::jsonb,
        error_code=null, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (result.rows.length !== 1) {
      throw new Error('Supplier financial operation completion failed.');
    }
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    failure: SupplierFinancialFailure,
  ): Promise<void> {
    const response = { code: failure.code, message: failure.message };
    const result = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected', response_code=${failure.statusCode},
        response_body=${JSON.stringify(response)}::jsonb,
        error_code=${failure.code}, completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
        and status='processing'
      returning operation_id
    `);
    if (result.rows.length !== 1) {
      throw new Error('Supplier financial operation rejection completion failed.');
    }
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    descriptor: MutationDescriptor,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts(
        store_id, operation_id, entity_type, entity_id, conflict_type, client_payload
      ) values (
        ${context.storeId}::uuid, ${descriptor.operationId}::uuid,
        ${descriptor.aggregateType}, ${descriptor.aggregateId}::uuid,
        'duplicate_identity',
        jsonb_build_object(
          'action',${descriptor.action}::text,
          'requestHash',${descriptor.requestHash}::text
        )
      )
    `);
  }

  private postgresqlErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('cause' in error && error.cause !== error) return this.postgresqlErrorCode(error.cause);
    return undefined;
  }

  private async readWithinTransaction(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
  ): Promise<SupplierFinancialReturnReadResponse | undefined> {
    const supplierResult = await transaction.execute<{
      id: string;
      status: 'active' | 'archived';
      payableMinor: string;
      creditMinor: string;
    }>(sql`
      select supplier.id, supplier.status,
        coalesce(sum(entry.payable_delta_minor),0)::text as "payableMinor",
        coalesce(sum(entry.credit_delta_minor),0)::text as "creditMinor"
      from ledger.suppliers supplier
      left join ledger.supplier_ledger_entries entry
        on entry.store_id=supplier.store_id and entry.supplier_id=supplier.id
      where supplier.store_id=${storeId}::uuid and supplier.id=${supplierId}::uuid
      group by supplier.id, supplier.status
    `);
    const supplier = supplierResult.rows[0];
    if (!supplier) return undefined;
    if (BigInt(supplier.payableMinor) < 0n || BigInt(supplier.creditMinor) < 0n) {
      throw new Error('Supplier financial balances are inconsistent.');
    }

    const operations = await this.readSupplierOperations(transaction, storeId, supplierId);
    const lineage = this.buildLineage(operations.corrections);

    const returnResult = await transaction.execute<{
      id: string;
      operationId: string;
      purchaseInvoiceId: string | null;
      amountMinor: string;
      payableReductionMinor: string;
      creditCreatedMinor: string;
      reason: string | null;
      status: 'posted' | 'cancelled' | 'draft';
      returnAt: Date | string;
      accountingPeriodId: string | null;
      itemCount: string;
    }>(sql`
      select root.id, root.operation_id as "operationId",
        root.purchase_invoice_id as "purchaseInvoiceId",
        root.total_minor::text as "amountMinor", root.notes as reason, root.status,
        root.return_at as "returnAt", root.accounting_period_id as "accountingPeriodId",
        coalesce(sum(-entry.payable_delta_minor) filter (
          where entry.entry_type='return'),0)::text as "payableReductionMinor",
        coalesce(sum(entry.credit_delta_minor) filter (
          where entry.entry_type='credit_created'),0)::text as "creditCreatedMinor",
        (select count(*)::text from ledger.supplier_return_items item
          where item.store_id=root.store_id and item.supplier_return_id=root.id) as "itemCount"
      from ledger.supplier_returns root
      left join ledger.supplier_ledger_entries entry
        on entry.store_id=root.store_id
        and entry.reference_type='supplier_return'
        and entry.reference_id=root.id
        and entry.entry_type in ('return','credit_created')
      where root.store_id=${storeId}::uuid and root.supplier_id=${supplierId}::uuid
      group by root.id
      order by root.return_at desc, root.id desc
    `);
    const returns = returnResult.rows.map((row) => {
      if (
        !row.purchaseInvoiceId ||
        !row.accountingPeriodId ||
        !row.reason ||
        row.status === 'draft' ||
        row.itemCount !== '0' ||
        BigInt(row.payableReductionMinor) + BigInt(row.creditCreatedMinor) !==
          BigInt(row.amountMinor)
      ) {
        throw new Error('Supplier Return read state is inconsistent.');
      }
      const snapshot = operations.postings.get(row.id);
      if (
        snapshot?.family !== 'supplier_return' ||
        snapshot.return.purchaseInvoiceId !== row.purchaseInvoiceId ||
        snapshot.return.amountMinor !== row.amountMinor ||
        snapshot.posting.accountingPeriodId !== row.accountingPeriodId ||
        snapshot.posting.occurredAt !== this.isoInstant(row.returnAt)
      ) {
        throw new Error('Supplier Return posting snapshot is inconsistent.');
      }
      const rowLineage = this.lineageFor(row.id, lineage);
      if (rowLineage.active !== (row.status === 'posted')) {
        throw new Error('Supplier Return active lineage is inconsistent.');
      }
      return {
        id: row.id,
        operationId: row.operationId,
        purchaseInvoiceId: row.purchaseInvoiceId,
        amountMinor: row.amountMinor,
        payableReductionMinor: row.payableReductionMinor,
        supplierCreditCreatedMinor: row.creditCreatedMinor,
        reason: row.reason,
        status: row.status,
        returnAt: this.isoInstant(row.returnAt),
        postingDate: snapshot.posting.postingDate,
        accountingPeriodId: row.accountingPeriodId,
        inventoryEffectMinor: '0' as const,
        lineage: rowLineage,
      };
    });

    const applicationResult = await transaction.execute<{
      id: string;
      operationId: string;
      purchaseInvoiceId: string;
      amountMinor: string;
      occurredAt: Date | string;
      accountingPeriodId: string;
      notes: string | null;
      reversalCount: string;
    }>(sql`
      select entry.id, entry.transaction_group_id as "operationId",
        entry.source_purchase_invoice_id as "purchaseInvoiceId",
        (-entry.credit_delta_minor)::text as "amountMinor",
        entry.occurred_at as "occurredAt", entry.accounting_period_id as "accountingPeriodId",
        entry.reason as notes,
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=entry.store_id and reversal.reversal_of_id=entry.id) as "reversalCount"
      from ledger.supplier_ledger_entries entry
      where entry.store_id=${storeId}::uuid and entry.supplier_id=${supplierId}::uuid
        and entry.entry_type='credit_used'
        and entry.reference_type='supplier_credit_application'
        and entry.reference_id=entry.id
      order by entry.occurred_at desc, entry.id desc
    `);
    const creditApplications = applicationResult.rows.map((row) => {
      const snapshot = operations.postings.get(row.id);
      if (
        snapshot?.family !== 'supplier_credit_application' ||
        snapshot.application.purchaseInvoiceId !== row.purchaseInvoiceId ||
        snapshot.application.amountMinor !== row.amountMinor ||
        snapshot.posting.accountingPeriodId !== row.accountingPeriodId ||
        snapshot.posting.occurredAt !== this.isoInstant(row.occurredAt)
      ) {
        throw new Error('Supplier Credit Application posting snapshot is inconsistent.');
      }
      const rowLineage = this.lineageFor(row.id, lineage);
      if (rowLineage.active !== (row.reversalCount === '0')) {
        throw new Error('Supplier Credit Application active lineage is inconsistent.');
      }
      return {
        id: row.id,
        operationId: snapshot.operationId,
        purchaseInvoiceId: row.purchaseInvoiceId,
        amountMinor: row.amountMinor,
        occurredAt: this.isoInstant(row.occurredAt),
        accountingPeriodId: row.accountingPeriodId,
        notes: row.notes,
        lineage: rowLineage,
      };
    });

    const refundResult = await transaction.execute<{
      id: string;
      operationId: string;
      moneyAccountId: string;
      moneyMovementId: string;
      amountMinor: string;
      occurredAt: Date | string;
      accountingPeriodId: string;
      notes: string | null;
      reversalCount: string;
      moneyReversalCount: string;
    }>(sql`
      select entry.id, entry.transaction_group_id as "operationId",
        movement.account_id as "moneyAccountId", movement.id as "moneyMovementId",
        (-entry.credit_delta_minor)::text as "amountMinor",
        entry.occurred_at as "occurredAt", entry.accounting_period_id as "accountingPeriodId",
        entry.reason as notes,
        (select count(*)::text from ledger.supplier_ledger_entries reversal
          where reversal.store_id=entry.store_id and reversal.reversal_of_id=entry.id) as "reversalCount",
        (select count(*)::text from ledger.money_movements reversal
          where reversal.store_id=movement.store_id and reversal.reversal_of_id=movement.id) as "moneyReversalCount"
      from ledger.supplier_ledger_entries entry
      inner join ledger.money_movements movement
        on movement.store_id=entry.store_id
        and movement.reference_type='supplier_refund' and movement.reference_id=entry.id
      where entry.store_id=${storeId}::uuid and entry.supplier_id=${supplierId}::uuid
        and entry.entry_type='refund' and entry.reference_type='supplier_refund'
        and entry.reference_id=entry.id
      order by entry.occurred_at desc, entry.id desc
    `);
    const refunds = refundResult.rows.map((row) => {
      const snapshot = operations.postings.get(row.id);
      if (
        snapshot?.family !== 'supplier_refund' ||
        snapshot.refund.moneyAccountId !== row.moneyAccountId ||
        snapshot.refund.moneyMovement.id !== row.moneyMovementId ||
        snapshot.refund.amountMinor !== row.amountMinor ||
        snapshot.posting.accountingPeriodId !== row.accountingPeriodId ||
        snapshot.posting.occurredAt !== this.isoInstant(row.occurredAt)
      ) {
        throw new Error('Supplier Refund posting snapshot is inconsistent.');
      }
      const rowLineage = this.lineageFor(row.id, lineage);
      if (rowLineage.active !== (row.reversalCount === '0' && row.moneyReversalCount === '0')) {
        throw new Error('Supplier Refund active lineage is inconsistent.');
      }
      return {
        id: row.id,
        operationId: snapshot.operationId,
        moneyAccountId: row.moneyAccountId,
        moneyMovementId: row.moneyMovementId,
        amountMinor: row.amountMinor,
        occurredAt: this.isoInstant(row.occurredAt),
        accountingPeriodId: row.accountingPeriodId,
        notes: row.notes,
        lineage: rowLineage,
      };
    });

    return {
      supplier: { id: supplier.id, status: supplier.status },
      balances: {
        payableMinor: supplier.payableMinor,
        supplierCreditAvailableMinor: supplier.creditMinor,
      },
      returns,
      creditApplications,
      refunds,
    };
  }

  private async readSupplierOperations(
    transaction: DatabaseTransaction,
    storeId: string,
    supplierId: string,
  ): Promise<{
    postings: Map<string, SupplierFinancialPostingResponse>;
    corrections: SupplierFinancialCorrectionResponse[];
  }> {
    const result = await transaction.execute<{ responseBody: unknown }>(sql`
      select response_body as "responseBody"
      from sync.processed_operations
      where store_id=${storeId}::uuid and status='applied'
        and aggregate_type in (${AGGREGATE_POSTING}, ${AGGREGATE_CORRECTION})
        and response_body->>'supplierId'=${supplierId}
      order by completed_at asc, operation_id asc
    `);
    const postings = new Map<string, SupplierFinancialPostingResponse>();
    const corrections: SupplierFinancialCorrectionResponse[] = [];
    for (const row of result.rows) {
      const response = parseStoredSupplierFinancialMutationResponse(row.responseBody);
      if ('intent' in response) {
        corrections.push(response);
        if (response.replacement) {
          postings.set(this.postingRootId(response.replacement), response.replacement);
        }
      } else {
        postings.set(this.postingRootId(response), response);
      }
    }
    return { postings, corrections };
  }

  private postingRootId(response: SupplierFinancialPostingResponse): string {
    if (response.family === 'supplier_return') return response.return.id;
    if (response.family === 'supplier_credit_application') return response.application.id;
    return response.refund.id;
  }

  private isoInstant(value: Date | string): string {
    const instant = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(instant.getTime())) {
      throw new Error('Supplier financial timestamp is invalid.');
    }
    return instant.toISOString();
  }

  private buildLineage(corrections: SupplierFinancialCorrectionResponse[]): {
    predecessor: Map<string, string>;
    successor: Map<string, string>;
    correction: Map<string, SupplierFinancialCorrectionResponse>;
  } {
    const predecessor = new Map<string, string>();
    const successor = new Map<string, string>();
    const correction = new Map<string, SupplierFinancialCorrectionResponse>();
    for (const item of corrections) {
      if (correction.has(item.target.id)) {
        throw new Error('Supplier financial correction lineage branches.');
      }
      correction.set(item.target.id, item);
      if (item.replacement) {
        const replacementId = this.postingRootId(item.replacement);
        if (predecessor.has(replacementId) || successor.has(item.target.id)) {
          throw new Error('Supplier financial correction lineage branches.');
        }
        predecessor.set(replacementId, item.target.id);
        successor.set(item.target.id, replacementId);
      }
    }
    return { predecessor, successor, correction };
  }

  private lineageFor(
    id: string,
    lineage: ReturnType<SupplierReturnRepository['buildLineage']>,
  ): SupplierFinancialLineageResponse {
    const correction = lineage.correction.get(id) ?? null;
    return {
      predecessorId: lineage.predecessor.get(id) ?? null,
      successorId: lineage.successor.get(id) ?? null,
      active: correction === null,
      correction: correction
        ? {
            intent: correction.intent,
            reason: correction.correctionReason,
            correctedAt: correction.posting.occurredAt,
            accountingPeriodId: correction.posting.accountingPeriodId,
          }
        : null,
    };
  }
}
