import { ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { purchaseInvoices, stores, supplierLedgerEntries } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import type { SupplierFinancialCorrectionCommand } from './supplier-invoice-correction-command';
import { parseStoredSupplierFinancialCorrectionResponse } from './supplier-invoice-correction-response';
import type {
  SupplierCorrectionFailure,
  SupplierCorrectionFailureCode,
  SupplierFinancialCorrectionResponse,
  SupplierFinancialCorrectionResult,
  SupplierInvoiceCorrectionResponse,
  SupplierOpeningPayableCorrectionResponse,
  SupplierPayableCorrectionEntry,
} from './supplier-invoice-correction.types';
import {
  SupplierInvoicePostingRepository,
  SupplierPostingRejectedError,
} from './supplier-invoice-posting.repository';
import type { SupplierPostingFailureCode } from './supplier-invoice-posting.types';

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
  invoiceId: string;
  supplierId: string;
  correctionOfId: string | null;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  totalMinor: string;
  invoiceOperationId: string;
  version: string;
  payableId: string;
  payableDeltaMinor: string;
  creditDeltaMinor: string;
  payableOperationId: string;
  itemCount: string;
  childCount: string;
  reversalCount: string;
}

interface OpeningTargetRow extends Record<string, unknown> {
  payableId: string;
  supplierId: string;
  payableDeltaMinor: string;
  creditDeltaMinor: string;
  payableOperationId: string;
  reversalCount: string;
}

interface TargetDescriptor {
  family: 'invoice' | 'opening_payable';
  aggregateId: string;
  correctionOfId: string | null;
}

interface FailureResult {
  ok: false;
  error: SupplierCorrectionFailure;
}

const correctionFailureDefinitions: Readonly<
  Record<
    Exclude<SupplierCorrectionFailureCode, SupplierPostingFailureCode>,
    SupplierCorrectionFailure
  >
> = {
  SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT: {
    code: 'SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT',
    message: 'Supplier financial correction target is inconsistent.',
    statusCode: 409,
  },
  SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE: {
    code: 'SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE',
    message: 'Supplier financial correction target is not the active operation.',
    statusCode: 409,
  },
  SUPPLIER_CORRECTION_TARGET_NOT_FOUND: {
    code: 'SUPPLIER_CORRECTION_TARGET_NOT_FOUND',
    message: 'Supplier financial correction target not found.',
    statusCode: 404,
  },
};

const postingFailureDefinitions: Readonly<
  Record<SupplierPostingFailureCode, SupplierCorrectionFailure>
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
  OPENING_PAYABLE_ALREADY_EXISTS: {
    code: 'OPENING_PAYABLE_ALREADY_EXISTS',
    message: 'An original opening payable already exists for this Supplier.',
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
  SUPPLIER_INVOICE_AMOUNT_INVALID: {
    code: 'SUPPLIER_INVOICE_AMOUNT_INVALID',
    message: 'Supplier Invoice quantity or amount is not representable.',
    statusCode: 400,
  },
  SUPPLIER_INVOICE_PRODUCT_LINK_NOT_FOUND: {
    code: 'SUPPLIER_INVOICE_PRODUCT_LINK_NOT_FOUND',
    message: 'Supplier Invoice Product link not found.',
    statusCode: 404,
  },
  SUPPLIER_NOT_FOUND: {
    code: 'SUPPLIER_NOT_FOUND',
    message: 'Supplier not found.',
    statusCode: 404,
  },
};

const failureDefinitions: Readonly<
  Record<SupplierCorrectionFailureCode, SupplierCorrectionFailure>
> = { ...postingFailureDefinitions, ...correctionFailureDefinitions };

class SupplierCorrectionRejectedError extends Error {
  constructor(readonly error: SupplierCorrectionFailure) {
    super(error.message);
    this.name = 'SupplierCorrectionRejectedError';
  }
}

function reject(code: SupplierCorrectionFailureCode): never {
  throw new SupplierCorrectionRejectedError(failureDefinitions[code]);
}

function failure(code: SupplierCorrectionFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class SupplierInvoiceCorrectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly invoicePosting: SupplierInvoicePostingRepository,
  ) {}

  correct(
    context: TenantTransactionContext,
    command: SupplierFinancialCorrectionCommand,
    postingDate: string,
  ): Promise<SupplierFinancialCorrectionResult> {
    const action = this.action(command);
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
    command: SupplierFinancialCorrectionCommand,
    postingDate: string,
  ): Promise<SupplierFinancialCorrectionResponse> {
    const targetOperation = await this.lockTargetOperation(
      transaction,
      context.storeId,
      command.targetOperationId,
    );
    const target = this.resolveTarget(targetOperation, command);
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    const posting = await this.resolvePosting(transaction, context, command, postingDate);

    if (target.family === 'invoice' && command.family === 'invoice') {
      return this.correctInvoice(
        transaction,
        context,
        command,
        target.aggregateId,
        target.correctionOfId,
        posting,
      );
    }
    if (target.family === 'opening_payable' && command.family === 'opening_payable') {
      return this.correctOpeningPayable(transaction, context, command, target.aggregateId, posting);
    }
    reject('SUPPLIER_CORRECTION_TARGET_NOT_FOUND');
  }

  private async correctInvoice(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: Extract<SupplierFinancialCorrectionCommand, { family: 'invoice' }>,
    invoiceId: string,
    correctionOfId: string | null,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierInvoiceCorrectionResponse> {
    const target = await this.loadInvoiceTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
      invoiceId,
      correctionOfId,
    );
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    const reversal = await this.insertReversal(transaction, context, command, posting, {
      supplierId: target.supplierId,
      payableId: target.payableId,
      payableDeltaMinor: BigInt(target.payableDeltaMinor),
      sourcePurchaseInvoiceId: target.invoiceId,
      referenceType: 'supplier_invoice_correction',
    });

    await transaction.execute(
      sql`select set_config('app.audit_reason', ${
        command.kind === 'edit' ? 'Supplier Invoice edited' : 'Supplier Invoice cancelled'
      }, true)`,
    );
    const cancelled = await transaction
      .update(purchaseInvoices)
      .set({ status: 'cancelled', cancelledAt: command.occurredAt })
      .where(
        and(
          eq(purchaseInvoices.storeId, context.storeId),
          eq(purchaseInvoices.id, target.invoiceId),
          eq(purchaseInvoices.status, 'open'),
        ),
      )
      .returning({ version: purchaseInvoices.version });
    const cancelledRow = cancelled[0];
    if (!cancelledRow) reject('SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE');

    const replacement =
      command.kind === 'edit'
        ? await this.invoicePosting.insertInvoiceWithinTransaction(
            transaction,
            context,
            command.replacement,
            posting,
            target.invoiceId,
          )
        : null;

    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      family: 'invoice',
      intent: command.kind,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      target: {
        invoiceId: target.invoiceId,
        supplierId: target.supplierId,
        status: 'cancelled',
        cancelledAt: command.occurredAt.toISOString(),
        version: cancelledRow.version.toString(),
      },
      reversal,
      replacement,
    };
  }

  private async correctOpeningPayable(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: Extract<SupplierFinancialCorrectionCommand, { family: 'opening_payable' }>,
    payableId: string,
    posting: AccountingPeriodPostingContext,
  ): Promise<SupplierOpeningPayableCorrectionResponse> {
    const target = await this.loadOpeningTarget(
      transaction,
      context.storeId,
      command.targetOperationId,
      payableId,
    );
    await this.assertTargetIsActive(transaction, context.storeId, command.targetOperationId);
    const reversal = await this.insertReversal(transaction, context, command, posting, {
      supplierId: target.supplierId,
      payableId: target.payableId,
      payableDeltaMinor: BigInt(target.payableDeltaMinor),
      sourcePurchaseInvoiceId: null,
      referenceType: 'supplier_opening_payable_correction',
    });
    const replacement =
      command.kind === 'edit'
        ? await this.invoicePosting.insertOpeningPayableWithinTransaction(
            transaction,
            context,
            command.replacement,
            posting,
            false,
          )
        : null;

    return {
      operationId: command.operationId,
      targetOperationId: command.targetOperationId,
      family: 'opening_payable',
      intent: command.kind,
      occurredAt: command.occurredAt.toISOString(),
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      target: {
        payableId: target.payableId,
        supplierId: target.supplierId,
        amountMinor: target.payableDeltaMinor,
      },
      reversal,
      replacement,
    };
  }

  private resolveTarget(
    row: ProcessedOperationRow | undefined,
    command: SupplierFinancialCorrectionCommand,
  ): TargetDescriptor {
    if (!row) reject('SUPPLIER_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'applied') reject('SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE');
    if (row.responseCode !== 201) reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');

    if (command.family === 'invoice') {
      if (row.action === 'supplier_invoices.post' && row.aggregateType === 'purchase_invoices') {
        const expected = deriveMoneyFactId(command.targetOperationId, 'supplier-invoice');
        if (row.aggregateId !== expected) reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        return { family: 'invoice', aggregateId: expected, correctionOfId: null };
      }
      if (row.action === 'supplier_invoices.edit') {
        const response = this.parseTargetResponse(row.responseBody);
        if (
          row.aggregateType !== 'supplier_financial_corrections' ||
          row.aggregateId !== command.targetOperationId ||
          response.family !== 'invoice' ||
          response.intent !== 'edit' ||
          response.operationId !== command.targetOperationId ||
          response.replacement === null
        ) {
          reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
        }
        return {
          family: 'invoice',
          aggregateId: response.replacement.invoice.id,
          correctionOfId: response.target.invoiceId,
        };
      }
      if (row.action === 'supplier_invoices.cancel') {
        reject('SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE');
      }
      reject('SUPPLIER_CORRECTION_TARGET_NOT_FOUND');
    }

    if (
      row.action === 'supplier_payables.opening' &&
      row.aggregateType === 'supplier_ledger_entries'
    ) {
      const expected = deriveMoneyFactId(command.targetOperationId, 'supplier-opening-payable');
      if (row.aggregateId !== expected) reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      return { family: 'opening_payable', aggregateId: expected, correctionOfId: null };
    }
    if (row.action === 'supplier_payables.opening.edit') {
      const response = this.parseTargetResponse(row.responseBody);
      if (
        row.aggregateType !== 'supplier_financial_corrections' ||
        row.aggregateId !== command.targetOperationId ||
        response.family !== 'opening_payable' ||
        response.intent !== 'edit' ||
        response.operationId !== command.targetOperationId ||
        response.replacement === null
      ) {
        reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
      }
      return {
        family: 'opening_payable',
        aggregateId: response.replacement.payable.id,
        correctionOfId: null,
      };
    }
    if (row.action === 'supplier_payables.opening.cancel') {
      reject('SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE');
    }
    reject('SUPPLIER_CORRECTION_TARGET_NOT_FOUND');
  }

  private async loadInvoiceTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
    invoiceId: string,
    expectedCorrectionOfId: string | null,
  ): Promise<InvoiceTargetRow> {
    const result = await transaction.execute<InvoiceTargetRow>(sql`
      select
        p.id as "invoiceId", p.supplier_id as "supplierId",
        p.correction_of_id as "correctionOfId", p.status,
        p.total_minor::text as "totalMinor", p.operation_id as "invoiceOperationId",
        p.version::text as version, l.id as "payableId",
        l.payable_delta_minor::text as "payableDeltaMinor",
        l.credit_delta_minor::text as "creditDeltaMinor",
        l.operation_id as "payableOperationId",
        (select count(*)::text from ledger.purchase_items i
          where i.store_id=p.store_id and i.purchase_invoice_id=p.id) as "itemCount",
        (select count(*)::text from ledger.purchase_invoices child
          where child.store_id=p.store_id and child.correction_of_id=p.id) as "childCount",
        (select count(*)::text from ledger.supplier_ledger_entries r
          where r.store_id=l.store_id and r.reversal_of_id=l.id) as "reversalCount"
      from ledger.purchase_invoices p
      inner join ledger.supplier_ledger_entries l
        on l.store_id=p.store_id and l.source_purchase_invoice_id=p.id
        and l.entry_type='supplier_invoice'
      where p.store_id=${storeId}::uuid and p.id=${invoiceId}::uuid
      for update of p, l
    `);
    if (result.rows.length !== 1) reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_CORRECTION_TARGET_NOT_FOUND');
    if (row.status !== 'open') reject('SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE');
    if (
      row.invoiceOperationId !== targetOperationId ||
      row.correctionOfId !== expectedCorrectionOfId ||
      row.payableOperationId !==
        deriveMoneyFactOperationId(targetOperationId, 'supplier-invoice-payable') ||
      row.totalMinor !== row.payableDeltaMinor ||
      BigInt(row.payableDeltaMinor) <= 0n ||
      row.creditDeltaMinor !== '0' ||
      row.itemCount === '0' ||
      row.childCount !== '0' ||
      row.reversalCount !== '0'
    ) {
      reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return row;
  }

  private parseTargetResponse(value: unknown): SupplierFinancialCorrectionResponse {
    try {
      return parseStoredSupplierFinancialCorrectionResponse(value);
    } catch {
      reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
  }

  private async loadOpeningTarget(
    transaction: DatabaseTransaction,
    storeId: string,
    targetOperationId: string,
    payableId: string,
  ): Promise<OpeningTargetRow> {
    const result = await transaction.execute<OpeningTargetRow>(sql`
      select l.id as "payableId", l.supplier_id as "supplierId",
        l.payable_delta_minor::text as "payableDeltaMinor",
        l.credit_delta_minor::text as "creditDeltaMinor",
        l.operation_id as "payableOperationId",
        (select count(*)::text from ledger.supplier_ledger_entries r
          where r.store_id=l.store_id and r.reversal_of_id=l.id) as "reversalCount"
      from ledger.supplier_ledger_entries l
      where l.store_id=${storeId}::uuid and l.id=${payableId}::uuid
        and l.entry_type='opening_balance' and l.source_purchase_invoice_id is null
      for update of l
    `);
    if (result.rows.length !== 1) reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    const row = result.rows[0];
    if (!row) reject('SUPPLIER_CORRECTION_TARGET_NOT_FOUND');
    if (
      row.payableOperationId !==
        deriveMoneyFactOperationId(targetOperationId, 'supplier-opening-payable') ||
      BigInt(row.payableDeltaMinor) <= 0n ||
      row.creditDeltaMinor !== '0' ||
      row.reversalCount !== '0'
    ) {
      reject('SUPPLIER_CORRECTION_TARGET_INTEGRITY_CONFLICT');
    }
    return row;
  }

  private async insertReversal(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierFinancialCorrectionCommand,
    posting: AccountingPeriodPostingContext,
    target: {
      supplierId: string;
      payableId: string;
      payableDeltaMinor: bigint;
      sourcePurchaseInvoiceId: string | null;
      referenceType: string;
    },
  ): Promise<SupplierPayableCorrectionEntry> {
    const rows = await transaction
      .insert(supplierLedgerEntries)
      .values({
        id: deriveMoneyFactId(command.operationId, 'supplier-payable-reversal'),
        storeId: context.storeId,
        supplierId: target.supplierId,
        accountingPeriodId: posting.accountingPeriodId,
        entryType: 'correction',
        payableDeltaMinor: -target.payableDeltaMinor,
        creditDeltaMinor: 0n,
        sourcePurchaseInvoiceId: target.sourcePurchaseInvoiceId,
        referenceType: target.referenceType,
        referenceId: target.payableId,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        occurredAt: command.occurredAt,
        reversalOfId: target.payableId,
        reason:
          command.family === 'invoice'
            ? `Supplier Invoice ${command.kind}`
            : `Supplier opening payable ${command.kind}`,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(command.operationId, 'supplier-payable-reversal'),
      })
      .returning({
        id: supplierLedgerEntries.id,
        entryType: supplierLedgerEntries.entryType,
        payableDeltaMinor: supplierLedgerEntries.payableDeltaMinor,
        creditDeltaMinor: supplierLedgerEntries.creditDeltaMinor,
        sourcePurchaseInvoiceId: supplierLedgerEntries.sourcePurchaseInvoiceId,
        transactionGroupId: supplierLedgerEntries.transactionGroupId,
        occurredAt: supplierLedgerEntries.occurredAt,
        reversalOfId: supplierLedgerEntries.reversalOfId,
        operationId: supplierLedgerEntries.operationId,
        createdAt: supplierLedgerEntries.createdAt,
      });
    const row = rows[0];
    if (!row || row.entryType !== 'correction' || row.reversalOfId === null) {
      throw new Error('Supplier payable correction insertion did not return the expected row.');
    }
    return {
      id: row.id,
      entryType: 'correction',
      payableDeltaMinor: row.payableDeltaMinor.toString(),
      creditDeltaMinor: row.creditDeltaMinor.toString(),
      sourcePurchaseInvoiceId: row.sourcePurchaseInvoiceId,
      transactionGroupId: row.transactionGroupId,
      occurredAt: row.occurredAt.toISOString(),
      reversalOfId: row.reversalOfId,
      operationId: row.operationId,
      createdAt: row.createdAt.toISOString(),
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
          and action in (
            'supplier_invoices.cancel', 'supplier_invoices.edit',
            'supplier_payables.opening.cancel', 'supplier_payables.opening.edit'
          )
          and response_body ->> 'targetOperationId'=${operationId}
      ) as superseded
    `);
    if (result.rows[0]?.superseded) reject('SUPPLIER_CORRECTION_TARGET_NOT_ACTIVE');
  }

  private async resolvePosting(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SupplierFinancialCorrectionCommand,
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
    command: SupplierFinancialCorrectionCommand,
    action: string,
  ): Promise<SupplierFinancialCorrectionResult | null> {
    let claimed = false;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid,
            ${context.deviceId}::uuid, 'supplier_financial_corrections',
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
    if (!existing) throw new Error('Supplier correction operation claim is missing.');
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
    command: SupplierFinancialCorrectionCommand,
    action: string,
    row: ProcessedOperationRow,
  ): Promise<SupplierFinancialCorrectionResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== 'supplier_financial_corrections' ||
      row.aggregateId !== command.operationId ||
      row.action !== action ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(
          store_id, operation_id, entity_type, entity_id, conflict_type, client_payload)
        values(
          ${context.storeId}::uuid, ${command.operationId}::uuid,
          'supplier_financial_corrections', ${command.operationId}::uuid,
          'duplicate_identity',
          jsonb_build_object('action', ${action}::text, 'requestHash', ${command.requestHash}::text))
      `);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201) throw new Error('Invalid Supplier correction replay status.');
      return {
        ok: true,
        response: parseStoredSupplierFinancialCorrectionResponse(row.responseBody),
      };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (
        !code ||
        !Object.hasOwn(failureDefinitions, code) ||
        row.responseCode !== failureDefinitions[code as SupplierCorrectionFailureCode].statusCode
      ) {
        throw new Error('Invalid Supplier correction rejection status.');
      }
      return failure(code as SupplierCorrectionFailureCode);
    }
    return failure('OPERATION_IN_PROGRESS');
  }

  private knownFailure(error: unknown): SupplierCorrectionFailure | undefined {
    if (error instanceof SupplierCorrectionRejectedError) return error.error;
    if (error instanceof SupplierPostingRejectedError) return error.result.error;
    return undefined;
  }

  private async completeApplied(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SupplierFinancialCorrectionResponse,
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
      throw new Error('Supplier correction operation completion failed.');
    }
  }

  private async completeRejected(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: SupplierCorrectionFailure,
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
      throw new Error('Supplier correction operation rejection failed.');
    }
  }

  private action(command: SupplierFinancialCorrectionCommand): string {
    return command.family === 'invoice'
      ? `supplier_invoices.${command.kind}`
      : `supplier_payables.opening.${command.kind}`;
  }
}
