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
  productUnits,
  purchaseInvoices,
  purchaseItems,
  stores,
  supplierLedgerEntries,
  suppliers,
} from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { inventoryBaseQuantity } from '../inventory/inventory-math';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import type {
  SupplierInvoicePostingCommand,
  SupplierOpeningPayableCommand,
} from './supplier-invoice-posting-command';
import {
  parseStoredSupplierInvoicePostingResponse,
  parseStoredSupplierOpeningPayableResponse,
} from './supplier-invoice-posting-response';
import type {
  PostedSupplierInvoiceItem,
  PostedSupplierPayableEntry,
  SupplierInvoicePostingResult,
  SupplierOpeningPayableResult,
  SupplierPostingFailure,
  SupplierPostingFailureCode,
  SupplierPostingResponse,
} from './supplier-invoice-posting.types';

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

interface MutationOperation {
  operationId: string;
  aggregateType: 'purchase_invoices' | 'supplier_ledger_entries';
  aggregateId: string;
  action: 'supplier_invoices.post' | 'supplier_payables.opening';
  requestHash: string;
}

interface FailureResult {
  ok: false;
  error: SupplierPostingFailure;
}

const failureDefinitions: Readonly<Record<SupplierPostingFailureCode, SupplierPostingFailure>> = {
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

class SupplierPostingRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'SupplierPostingRejectedError';
  }
}

function failure(code: SupplierPostingFailureCode): FailureResult {
  return { ok: false, error: failureDefinitions[code] };
}

@Injectable()
export class SupplierInvoicePostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
  ) {}

  postInvoice(
    context: TenantTransactionContext,
    command: SupplierInvoicePostingCommand,
    postingDate: string,
  ): Promise<SupplierInvoicePostingResult> {
    const invoiceId = deriveMoneyFactId(command.operationId, 'supplier-invoice');
    const operation: MutationOperation = {
      operationId: command.operationId,
      aggregateType: 'purchase_invoices',
      aggregateId: invoiceId,
      action: 'supplier_invoices.post',
      requestHash: command.requestHash,
    };

    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) return begun as SupplierInvoicePostingResult;

      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(
            savepoint,
            context,
            command.operationId,
            postingDate,
          );
          await this.lockSupplier(savepoint, context.storeId, command.supplierId);
          const items = await this.prepareItems(savepoint, context.storeId, command);
          const displayNumber = `PI-${invoiceId}`;

          await savepoint.insert(purchaseInvoices).values({
            id: invoiceId,
            storeId: context.storeId,
            supplierId: command.supplierId,
            invoiceNumber: command.invoiceNumber,
            displayNumber,
            invoiceDateAt: command.occurredAt,
            dueAt: command.dueAt,
            itemsSubtotalMinor: command.itemsSubtotalMinor,
            lineDiscountTotalMinor: command.lineDiscountTotalMinor,
            invoiceDiscountMinor: command.invoiceDiscountMinor,
            roundingMinor: command.roundingMinor,
            totalMinor: command.totalMinor,
            status: 'draft',
            notes: command.notes,
            deviceId: context.deviceId,
            operationId: command.operationId,
          });

          await savepoint.insert(purchaseItems).values(
            items.map((item) => ({
              id: item.id,
              storeId: context.storeId,
              purchaseInvoiceId: invoiceId,
              productId: item.productId,
              productUnitId: item.productUnitId,
              productNameSnapshot: item.description,
              unitNameSnapshot: item.unitName,
              quantityMilli: BigInt(item.quantityMilli),
              conversionFactorNum: item.conversionFactorNumerator,
              conversionFactorDen: item.conversionFactorDenominator,
              baseQuantityMilli: BigInt(item.baseQuantityMilli),
              unitCostMinor: BigInt(item.unitCostMinor),
              lineGrossMinor: BigInt(item.lineGrossMinor),
              lineDiscountMinor: BigInt(item.lineDiscountMinor),
              roundingMinor: BigInt(item.roundingMinor),
              lineTotalMinor: BigInt(item.lineTotalMinor),
            })),
          );

          const payable = await this.insertPayable(savepoint, context, {
            id: deriveMoneyFactId(command.operationId, 'supplier-invoice-payable'),
            operationId: deriveMoneyFactOperationId(
              command.operationId,
              'supplier-invoice-payable',
            ),
            supplierId: command.supplierId,
            accountingPeriodId: posting.accountingPeriodId,
            entryType: 'supplier_invoice',
            payableDeltaMinor: command.totalMinor,
            sourcePurchaseInvoiceId: invoiceId,
            referenceType: 'supplier_invoice',
            referenceId: invoiceId,
            transactionGroupId: deriveTransactionGroupId(command.operationId),
            occurredAt: command.occurredAt,
            reason: command.notes,
          });

          const finalized = await savepoint
            .update(purchaseInvoices)
            .set({
              status: 'open',
              accountingPeriodId: posting.accountingPeriodId,
              postingDate: posting.postingDate,
            })
            .where(
              and(
                eq(purchaseInvoices.storeId, context.storeId),
                eq(purchaseInvoices.id, invoiceId),
                eq(purchaseInvoices.status, 'draft'),
              ),
            )
            .returning({ version: purchaseInvoices.version });
          const header = finalized[0];
          if (!header) throw new Error('Supplier Invoice finalization did not return a row.');

          await savepoint.execute(
            sql`set constraints ledger.supplier_ledger_entries_store_id_source_purchase_invoice_i_fkey immediate`,
          );
          const payableCount = await savepoint.execute<{ count: string }>(sql`
            select count(*)::text as count
            from ledger.supplier_ledger_entries
            where store_id = ${context.storeId}::uuid
              and source_purchase_invoice_id = ${invoiceId}::uuid
              and entry_type = 'supplier_invoice'
          `);
          if (payableCount.rows[0]?.count !== '1') {
            throw new Error('Supplier Invoice payable effect is incomplete.');
          }

          return {
            operationId: command.operationId,
            supplierId: command.supplierId,
            businessDate: posting.postingDate,
            postingDate: posting.postingDate,
            accountingPeriodId: posting.accountingPeriodId,
            invoice: {
              id: invoiceId,
              invoiceNumber: command.invoiceNumber,
              displayNumber,
              occurredAt: command.occurredAt.toISOString(),
              dueAt: command.dueAt?.toISOString() ?? null,
              status: 'open' as const,
              itemsSubtotalMinor: command.itemsSubtotalMinor.toString(),
              lineDiscountTotalMinor: command.lineDiscountTotalMinor.toString(),
              invoiceDiscountMinor: command.invoiceDiscountMinor.toString(),
              roundingMinor: command.roundingMinor.toString(),
              totalMinor: command.totalMinor.toString(),
              notes: command.notes,
              version: header.version.toString(),
            },
            items,
            payable,
          };
        });

        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  postOpeningPayable(
    context: TenantTransactionContext,
    command: SupplierOpeningPayableCommand,
    postingDate: string,
  ): Promise<SupplierOpeningPayableResult> {
    const payableId = deriveMoneyFactId(command.operationId, 'supplier-opening-payable');
    const operation: MutationOperation = {
      operationId: command.operationId,
      aggregateType: 'supplier_ledger_entries',
      aggregateId: payableId,
      action: 'supplier_payables.opening',
      requestHash: command.requestHash,
    };

    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) return begun;

      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(
            savepoint,
            context,
            command.operationId,
            postingDate,
          );
          await this.lockSupplier(savepoint, context.storeId, command.supplierId);
          const existing = await savepoint.execute<{ present: boolean }>(sql`
            select exists (
              select 1 from ledger.supplier_ledger_entries
              where store_id = ${context.storeId}::uuid
                and supplier_id = ${command.supplierId}::uuid
                and entry_type = 'opening_balance'
                and reversal_of_id is null
            ) as present
          `);
          if (existing.rows[0]?.present === true) {
            throw new SupplierPostingRejectedError(failure('OPENING_PAYABLE_ALREADY_EXISTS'));
          }

          const payable = await this.insertPayable(savepoint, context, {
            id: payableId,
            operationId: deriveMoneyFactOperationId(
              command.operationId,
              'supplier-opening-payable',
            ),
            supplierId: command.supplierId,
            accountingPeriodId: posting.accountingPeriodId,
            entryType: 'opening_balance',
            payableDeltaMinor: command.amountMinor,
            sourcePurchaseInvoiceId: null,
            referenceType: 'opening_balance',
            referenceId: payableId,
            transactionGroupId: deriveTransactionGroupId(command.operationId),
            occurredAt: command.occurredAt,
            reason: command.notes,
          });
          return {
            operationId: command.operationId,
            supplierId: command.supplierId,
            businessDate: posting.postingDate,
            postingDate: posting.postingDate,
            accountingPeriodId: posting.accountingPeriodId,
            payable,
          };
        });

        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  private async prepareItems(
    transaction: DatabaseTransaction,
    storeId: string,
    command: SupplierInvoicePostingCommand,
  ): Promise<PostedSupplierInvoiceItem[]> {
    const result: PostedSupplierInvoiceItem[] = [];
    for (const [index, item] of command.items.entries()) {
      let factorNum = 1;
      let factorDen = 1;
      if (item.productId !== null && item.productUnitId !== null) {
        const rows = await transaction
          .select({ factorNum: productUnits.factorNum, factorDen: productUnits.factorDen })
          .from(productUnits)
          .where(
            and(
              eq(productUnits.storeId, storeId),
              eq(productUnits.productId, item.productId),
              eq(productUnits.id, item.productUnitId),
            ),
          )
          .limit(1)
          .for('share');
        const unit = rows[0];
        if (!unit) {
          throw new SupplierPostingRejectedError(
            failure('SUPPLIER_INVOICE_PRODUCT_LINK_NOT_FOUND'),
          );
        }
        factorNum = unit.factorNum;
        factorDen = unit.factorDen;
      }

      let baseQuantityMilli: bigint;
      try {
        baseQuantityMilli = inventoryBaseQuantity(item.quantityMilli, factorNum, factorDen);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new SupplierPostingRejectedError(failure('SUPPLIER_INVOICE_AMOUNT_INVALID'));
        }
        throw error;
      }
      result.push({
        id: deriveMoneyFactId(command.operationId, `supplier-invoice-item-${String(index)}`),
        productId: item.productId,
        productUnitId: item.productUnitId,
        description: item.description,
        unitName: item.unitName,
        quantityMilli: item.quantityMilli.toString(),
        conversionFactorNumerator: factorNum,
        conversionFactorDenominator: factorDen,
        baseQuantityMilli: baseQuantityMilli.toString(),
        unitCostMinor: item.unitCostMinor.toString(),
        lineGrossMinor: item.lineGrossMinor.toString(),
        lineDiscountMinor: item.lineDiscountMinor.toString(),
        roundingMinor: item.roundingMinor.toString(),
        lineTotalMinor: item.lineTotalMinor.toString(),
      });
    }
    return result;
  }

  private async insertPayable(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    value: {
      id: string;
      operationId: string;
      supplierId: string;
      accountingPeriodId: string;
      entryType: 'supplier_invoice' | 'opening_balance';
      payableDeltaMinor: bigint;
      sourcePurchaseInvoiceId: string | null;
      referenceType: string;
      referenceId: string;
      transactionGroupId: string;
      occurredAt: Date;
      reason: string | null;
    },
  ): Promise<PostedSupplierPayableEntry> {
    const rows = await transaction
      .insert(supplierLedgerEntries)
      .values({
        ...value,
        storeId: context.storeId,
        creditDeltaMinor: 0n,
        deviceId: context.deviceId,
      })
      .returning({
        id: supplierLedgerEntries.id,
        entryType: supplierLedgerEntries.entryType,
        payableDeltaMinor: supplierLedgerEntries.payableDeltaMinor,
        creditDeltaMinor: supplierLedgerEntries.creditDeltaMinor,
        sourcePurchaseInvoiceId: supplierLedgerEntries.sourcePurchaseInvoiceId,
        transactionGroupId: supplierLedgerEntries.transactionGroupId,
        occurredAt: supplierLedgerEntries.occurredAt,
        operationId: supplierLedgerEntries.operationId,
        createdAt: supplierLedgerEntries.createdAt,
      });
    const row = rows[0];
    if (!row || (row.entryType !== 'supplier_invoice' && row.entryType !== 'opening_balance')) {
      throw new Error('Supplier payable insertion did not return the expected row.');
    }
    return {
      id: row.id,
      entryType: row.entryType,
      payableDeltaMinor: row.payableDeltaMinor.toString(),
      creditDeltaMinor: row.creditDeltaMinor.toString(),
      sourcePurchaseInvoiceId: row.sourcePurchaseInvoiceId,
      transactionGroupId: row.transactionGroupId,
      occurredAt: row.occurredAt.toISOString(),
      operationId: row.operationId,
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
    if (!rows[0]) throw new SupplierPostingRejectedError(failure('SUPPLIER_NOT_FOUND'));
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
        throw new SupplierPostingRejectedError(failure('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'));
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        throw new SupplierPostingRejectedError(failure('ACCOUNTING_PERIOD_INTEGRITY_CONFLICT'));
      }
      throw error;
    }
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<{ ok: true; response: SupplierPostingResponse } | FailureResult | null> {
    const prior = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (prior) return this.resolveProcessedOperation(transaction, context, operation, prior);

    await this.lockActiveStoreForNewWrite(transaction, context.storeId);
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid,
            ${operation.operationId}::uuid,
            ${context.deviceId}::uuid,
            ${operation.aggregateType},
            ${operation.aggregateId}::uuid,
            ${operation.action},
            ${operation.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
      const concurrent = await this.readProcessedOperation(
        transaction,
        context.storeId,
        operation.operationId,
      );
      if (!concurrent) throw error;
      return this.resolveProcessedOperation(transaction, context, operation, concurrent);
    }
    if (claimed) return null;
    const existing = await this.readProcessedOperation(
      transaction,
      context.storeId,
      operation.operationId,
    );
    if (!existing) throw new Error('Claimed Supplier posting operation could not be read.');
    return this.resolveProcessedOperation(transaction, context, operation, existing);
  }

  private async lockActiveStoreForNewWrite(
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
        aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
        response_code as "responseCode", response_body as "responseBody", error_code as "errorCode"
      from sync.processed_operations
      where store_id = ${storeId}::uuid and operation_id = ${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
    existing: ProcessedOperationRow,
  ): Promise<{ ok: true; response: SupplierPostingResponse } | FailureResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== operation.aggregateType ||
      existing.aggregateId !== operation.aggregateId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
      await this.recordOperationConflict(transaction, context, operation);
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      if (existing.responseCode !== 201)
        throw new Error('Stored Supplier posting status is invalid.');
      return {
        ok: true,
        response:
          operation.action === 'supplier_invoices.post'
            ? parseStoredSupplierInvoicePostingResponse(existing.responseBody)
            : parseStoredSupplierOpeningPayableResponse(existing.responseBody),
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
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      !('code' in body) ||
      body.code !== code ||
      !('message' in body) ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Supplier posting rejection is invalid.');
    }
    const definition = failureDefinitions[code as SupplierPostingFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Supplier posting rejection status is invalid.');
    }
    return {
      ok: false,
      error: { ...definition, message: body.message },
    };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SupplierPostingResponse,
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
      throw new Error('Supplier posting operation completion failed.');
    }
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof SupplierPostingRejectedError)) throw error;
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
      throw new Error('Supplier posting operation rejection failed.');
    }
    return error.result;
  }

  private async recordOperationConflict(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<void> {
    await transaction.execute(sql`
      insert into sync.conflicts(
        store_id, operation_id, entity_type, entity_id, conflict_type, client_payload
      ) values (
        ${context.storeId}::uuid, ${operation.operationId}::uuid,
        ${operation.aggregateType}, ${operation.aggregateId}::uuid, 'duplicate_identity',
        jsonb_build_object('action', ${operation.action}::text,
          'requestHash', ${operation.requestHash}::text)
      )
    `);
  }
}
