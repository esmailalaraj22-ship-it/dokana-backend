import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import { saleReturnItems, saleReturnSettlements, saleReturns } from '../database/schema';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  InventoryPostingRepository,
  SaleReturnInventoryError,
} from '../inventory/inventory-posting.repository';
import type { PostedCustomerReturnRestock } from '../inventory/inventory-return.types';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import { CustomerCreditRepository } from '../sales/customer-credit.repository';
import type { CustomerReturnLedgerEffect } from '../sales/customer-credit.types';
import { SaleReturnAuthorityRepository } from './sale-return-authority.repository';
import { parseStoredSaleReturnPostingResponse } from './sale-return-posting-response';
import type {
  PostedSaleReturnSettlement,
  SaleReturnPostingFailure,
  SaleReturnPostingFailureCode,
  SaleReturnPostingResponse,
  SaleReturnPostingResult,
  SaleReturnSettlementKind,
} from './sale-return-posting.types';
import type {
  SaleReturnCalculatedLine,
  SaleReturnCommand,
  SaleReturnPlan,
} from './sale-return.types';
import { SaleReturnAuthorityError } from './sale-return.types';

const AGGREGATE = 'sale_returns';
const ACTION = 'sale_returns.post';

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

const failureDefinitions: Readonly<Record<SaleReturnPostingFailureCode, SaleReturnPostingFailure>> =
  {
    ACCOUNTING_PERIOD_INTEGRITY_CONFLICT: definition(
      'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
      'Accounting Period identity or boundaries are inconsistent.',
      409,
    ),
    ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE: definition(
      'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
      'Accounting Period is not eligible for posting.',
      409,
    ),
    OPERATION_ID_CONFLICT: definition(
      'OPERATION_ID_CONFLICT',
      'Operation ID was reused with a different request.',
      409,
    ),
    OPERATION_IN_PROGRESS: definition(
      'OPERATION_IN_PROGRESS',
      'The operation is still being processed.',
      409,
    ),
    SALE_RETURN_AMOUNT_INVALID: definition(
      'SALE_RETURN_AMOUNT_INVALID',
      'Sale Return amount is invalid or not representable.',
      400,
    ),
    SALE_RETURN_CUSTOMER_CREDIT_NOT_ALLOWED: definition(
      'SALE_RETURN_CUSTOMER_CREDIT_NOT_ALLOWED',
      'Customer Credit is not available for this Sale Return.',
      409,
    ),
    SALE_RETURN_CUSTOMER_RESTORE_REQUIRED: definition(
      'SALE_RETURN_CUSTOMER_RESTORE_REQUIRED',
      'The Customer must be active before creating new Customer Credit.',
      409,
    ),
    SALE_RETURN_INTEGRITY_CONFLICT: definition(
      'SALE_RETURN_INTEGRITY_CONFLICT',
      'Sale Return state is inconsistent.',
      409,
    ),
    SALE_RETURN_LINE_NOT_FOUND: definition(
      'SALE_RETURN_LINE_NOT_FOUND',
      'Sale Return line not found.',
      404,
    ),
    SALE_RETURN_OPERATION_CONFLICT: definition(
      'SALE_RETURN_OPERATION_CONFLICT',
      'Sale Return operation conflicts with the stored operation.',
      409,
    ),
    SALE_RETURN_QUANTITY_EXCEEDED: definition(
      'SALE_RETURN_QUANTITY_EXCEEDED',
      'Returned quantity exceeds the remaining Sale quantity.',
      409,
    ),
    SALE_RETURN_REFUND_ACCOUNT_UNAVAILABLE: definition(
      'SALE_RETURN_REFUND_ACCOUNT_UNAVAILABLE',
      'Refund Money Account is not available.',
      409,
    ),
    SALE_RETURN_RESTOCK_UNAVAILABLE: definition(
      'SALE_RETURN_RESTOCK_UNAVAILABLE',
      'Saleable restock is not available for this Sale line.',
      409,
    ),
    SALE_RETURN_RESIDUAL_CHOICE_INVALID: definition(
      'SALE_RETURN_RESIDUAL_CHOICE_INVALID',
      'Residual settlement choice is not applicable.',
      409,
    ),
    SALE_RETURN_RESIDUAL_CHOICE_REQUIRED: definition(
      'SALE_RETURN_RESIDUAL_CHOICE_REQUIRED',
      'Residual settlement choice is required.',
      409,
    ),
    SALE_RETURN_SALE_INACTIVE: definition(
      'SALE_RETURN_SALE_INACTIVE',
      'Sale is not active for a new Return.',
      409,
    ),
    SALE_RETURN_SALE_NOT_FOUND: definition('SALE_RETURN_SALE_NOT_FOUND', 'Sale not found.', 404),
    SALE_RETURN_WINDOW_EXPIRED: definition(
      'SALE_RETURN_WINDOW_EXPIRED',
      'The 48-hour Sale Return window has expired.',
      409,
    ),
  };

@Injectable()
export class SaleReturnPostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly authority: SaleReturnAuthorityRepository,
    private readonly inventory: InventoryPostingRepository,
    private readonly customerCredit: CustomerCreditRepository,
    private readonly moneyMovements: MoneyMovementPostingRepository,
  ) {}

  post(
    context: TenantTransactionContext,
    command: SaleReturnCommand,
    postingDate: string,
  ): Promise<SaleReturnPostingResult> {
    const returnId = deriveMoneyFactId(command.operationId, 'sale-return');
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const prior = await this.beginMutation(transaction, context, command, returnId);
      if (prior) return prior;

      try {
        const response = await transaction.transaction((savepoint) =>
          this.insertWithinTransaction(savepoint, context, command, postingDate, returnId),
        );
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        const known = this.knownFailure(error);
        if (!known) throw error;
        await this.rejectOperation(transaction, context.storeId, command.operationId, known);
        return { ok: false, error: known };
      }
    });
  }

  private async insertWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCommand,
    postingDate: string,
    returnId: string,
  ): Promise<SaleReturnPostingResponse> {
    const posting = await this.postingContext.resolveForWrite(transaction, context, {
      postingDate,
      operationId: command.operationId,
    });
    const plan = await this.authority.buildNewPlanWithinTransaction(
      transaction,
      context.storeId,
      command,
    );
    await transaction.execute(
      sql`select set_config('app.audit_reason', ${command.reason}::text, true)`,
    );

    const rootRows = await transaction
      .insert(saleReturns)
      .values({
        id: returnId,
        storeId: context.storeId,
        saleId: plan.saleId,
        customerId: plan.customerId,
        accountingPeriodId: posting.accountingPeriodId,
        displayNumber: `SR-${returnId}`,
        returnAt: command.occurredAt,
        totalMinor: plan.totalReturnValueMinor,
        status: 'draft',
        notes: command.reason,
        deviceId: context.deviceId,
        operationId: command.operationId,
      })
      .returning({
        createdAt: saleReturns.createdAt,
        displayNumber: saleReturns.displayNumber,
      });
    const root = rootRows[0];
    if (!root) throw new Error('Sale Return insertion did not return a row.');

    const returnItemIds = new Map(
      plan.lines.map((line) => [
        line.saleItemId,
        deriveMoneyFactId(command.operationId, `sale-return-item:${line.saleItemId}`),
      ]),
    );
    const restocks = await this.inventory.insertCustomerReturnRestocksWithinTransaction(
      transaction,
      context,
      {
        operationId: command.operationId,
        returnId,
        occurredAt: command.occurredAt,
        reason: command.reason,
        posting,
        lines: plan.lines
          .filter(
            (
              line,
            ): line is SaleReturnCalculatedLine & {
              productId: string;
              productUnitId: string;
              returnBaseQuantityMilli: bigint;
            } =>
              line.inventoryQuantityDeltaMilli > 0n &&
              line.productId !== null &&
              line.productUnitId !== null &&
              line.returnBaseQuantityMilli !== null,
          )
          .map((line) => ({
            saleItemId: line.saleItemId,
            returnItemId: required(returnItemIds.get(line.saleItemId)),
            productId: line.productId,
            productUnitId: line.productUnitId,
            selectedQuantityMilli: line.requestedQuantityMilli,
            expectedBaseQuantityMilli: line.returnBaseQuantityMilli,
            factorNum: line.conversionFactorNum,
            factorDen: line.conversionFactorDen,
            historicalCostState: line.costStatus === 'estimated' ? 'unknown' : line.costStatus,
            historicalCostMinor: line.costStatus === 'known' ? line.cogsReversalMinor : null,
          })),
      },
    );
    const restockBySaleItem = new Map(restocks.map((effect) => [effect.saleItemId, effect]));

    for (const line of plan.lines) {
      await transaction.insert(saleReturnItems).values({
        id: required(returnItemIds.get(line.saleItemId)),
        storeId: context.storeId,
        saleReturnId: returnId,
        saleItemId: line.saleItemId,
        quantityMilli: line.requestedQuantityMilli,
        baseQuantityMilli: line.returnBaseQuantityMilli,
        lineRefundMinor: line.returnValueMinor,
        itemCondition: line.physicalCondition,
        inventoryMovementId: restockBySaleItem.get(line.saleItemId)?.movementId ?? null,
      });
    }

    const settlements = await this.insertSettlements(
      transaction,
      context,
      command,
      plan,
      posting,
      returnId,
    );
    const postedRows = await transaction
      .update(saleReturns)
      .set({ status: 'posted' })
      .where(and(eq(saleReturns.storeId, context.storeId), eq(saleReturns.id, returnId)))
      .returning({ version: saleReturns.version });
    const posted = postedRows[0];
    if (!posted) throw new Error('Sale Return posting did not update a row.');
    if (restocks.length > 0) {
      await transaction.execute(
        sql`set constraints ledger.stock_balances_last_movement_fkey immediate`,
      );
    }

    return this.response(
      command,
      plan,
      posting,
      returnId,
      root,
      posted.version,
      restockBySaleItem,
      settlements,
    );
  }

  private async insertSettlements(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCommand,
    plan: SaleReturnPlan,
    posting: AccountingPeriodPostingContext,
    returnId: string,
  ): Promise<PostedSaleReturnSettlement[]> {
    const effects: PostedSaleReturnSettlement[] = [];
    if (plan.settlement.receivableReductionMinor > 0n) {
      const ledger = await this.insertCustomerLedgerEffect(
        transaction,
        context,
        command,
        plan,
        posting,
        returnId,
        'receivable_reduction',
        'sale-return-receivable',
        'return',
        -plan.settlement.receivableReductionMinor,
        0n,
        'sale_return',
      );
      effects.push(
        await this.insertCustomerSettlement(
          transaction,
          context.storeId,
          command.operationId,
          returnId,
          'receivable_reduction',
          plan.settlement.receivableReductionMinor,
          ledger,
        ),
      );
    }
    if (plan.settlement.originalCustomerCreditRestorationMinor > 0n) {
      const ledger = await this.insertCustomerLedgerEffect(
        transaction,
        context,
        command,
        plan,
        posting,
        returnId,
        'original_customer_credit_restoration',
        'sale-return-original-credit',
        'credit_created',
        0n,
        plan.settlement.originalCustomerCreditRestorationMinor,
        'sale_return_original_credit_restoration',
      );
      effects.push(
        await this.insertCustomerSettlement(
          transaction,
          context.storeId,
          command.operationId,
          returnId,
          'original_customer_credit_restoration',
          plan.settlement.originalCustomerCreditRestorationMinor,
          ledger,
        ),
      );
    }
    if (plan.settlement.newCustomerCreditMinor > 0n) {
      const ledger = await this.insertCustomerLedgerEffect(
        transaction,
        context,
        command,
        plan,
        posting,
        returnId,
        'new_customer_credit',
        'sale-return-new-credit',
        'credit_created',
        0n,
        plan.settlement.newCustomerCreditMinor,
        'sale_return',
      );
      effects.push(
        await this.insertCustomerSettlement(
          transaction,
          context.storeId,
          command.operationId,
          returnId,
          'new_customer_credit',
          plan.settlement.newCustomerCreditMinor,
          ledger,
        ),
      );
    }
    if (plan.settlement.refundMinor > 0n) {
      const accountId = required(plan.settlement.refundMoneyAccountId);
      const movement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: 'sale-return-refund-money',
          accountId,
          amountDeltaMinor: -plan.settlement.refundMinor,
          movementType: 'customer_refund',
          referenceType: 'sale_return',
          referenceId: returnId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId: deriveTransactionGroupId(command.operationId),
          notes: command.reason,
        },
      );
      const kind = 'money_refund';
      const id = deriveMoneyFactId(command.operationId, `sale-return-settlement:${kind}`);
      await transaction.insert(saleReturnSettlements).values({
        id,
        storeId: context.storeId,
        saleReturnId: returnId,
        settlementType: 'money_refund',
        amountMinor: plan.settlement.refundMinor,
        moneyAccountId: accountId,
        moneyMovementId: movement.id,
      });
      effects.push({
        id,
        kind,
        amountMinor: plan.settlement.refundMinor.toString(),
        customerLedgerEntryId: null,
        customerLedgerOperationId: null,
        moneyAccountId: accountId,
        moneyMovement: movement,
      });
    }
    return effects;
  }

  private insertCustomerLedgerEffect(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCommand,
    plan: SaleReturnPlan,
    posting: AccountingPeriodPostingContext,
    returnId: string,
    _kind: SaleReturnSettlementKind,
    discriminator: string,
    entryType: 'return' | 'credit_created',
    receivableDeltaMinor: bigint,
    creditDeltaMinor: bigint,
    referenceType: 'sale_return' | 'sale_return_original_credit_restoration',
  ): Promise<CustomerReturnLedgerEffect> {
    return this.customerCredit.insertReturnLedgerEffectWithinTransaction(transaction, context, {
      commandOperationId: command.operationId,
      discriminator,
      returnId,
      saleId: plan.saleId,
      customerId: required(plan.customerId),
      accountingPeriodId: posting.accountingPeriodId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      occurredAt: command.occurredAt,
      reason: command.reason,
      entryType,
      receivableDeltaMinor,
      creditDeltaMinor,
      referenceType,
    });
  }

  private async insertCustomerSettlement(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    returnId: string,
    kind: Exclude<SaleReturnSettlementKind, 'money_refund'>,
    amountMinor: bigint,
    ledger: CustomerReturnLedgerEffect,
  ): Promise<PostedSaleReturnSettlement> {
    const id = deriveMoneyFactId(operationId, `sale-return-settlement:${kind}`);
    await transaction.insert(saleReturnSettlements).values({
      id,
      storeId,
      saleReturnId: returnId,
      settlementType: kind === 'receivable_reduction' ? 'reduce_receivable' : 'customer_credit',
      amountMinor,
      customerLedgerEntryId: ledger.id,
    });
    return {
      id,
      kind,
      amountMinor: amountMinor.toString(),
      customerLedgerEntryId: ledger.id,
      customerLedgerOperationId: ledger.operationId,
      moneyAccountId: null,
      moneyMovement: null,
    };
  }

  private response(
    command: SaleReturnCommand,
    plan: SaleReturnPlan,
    posting: AccountingPeriodPostingContext,
    returnId: string,
    root: { createdAt: Date; displayNumber: string },
    version: bigint,
    restocks: Map<string, PostedCustomerReturnRestock>,
    settlements: PostedSaleReturnSettlement[],
  ): SaleReturnPostingResponse {
    return {
      operationId: command.operationId,
      transactionGroupId: deriveTransactionGroupId(command.operationId),
      return: {
        id: returnId,
        displayNumber: root.displayNumber,
        saleId: plan.saleId,
        saleDisplayNumber: plan.saleDisplayNumber,
        customerId: plan.customerId,
        totalMinor: plan.totalReturnValueMinor.toString(),
        status: 'posted',
        returnAt: command.occurredAt.toISOString(),
        createdAt: root.createdAt.toISOString(),
        version: version.toString(),
      },
      lines: plan.lines.map((line) => {
        const inventory = restocks.get(line.saleItemId);
        return {
          id: deriveMoneyFactId(command.operationId, `sale-return-item:${line.saleItemId}`),
          saleItemId: line.saleItemId,
          productId: line.productId,
          productUnitId: line.productUnitId,
          quantityMilli: line.requestedQuantityMilli.toString(),
          baseQuantityMilli: line.returnBaseQuantityMilli?.toString() ?? null,
          lineRefundMinor: line.returnValueMinor.toString(),
          disposition: line.disposition,
          itemCondition: line.physicalCondition,
          costStatus: line.costStatus,
          historicalCostMinor: line.returnHistoricalCostMinor?.toString() ?? null,
          cogsReversalMinor: line.cogsReversalMinor?.toString() ?? null,
          inventoryMovement: inventory
            ? {
                id: inventory.movementId,
                operationId: inventory.movementOperationId,
                quantityDeltaMilli: inventory.quantityDeltaMilli,
                valueDeltaMinor: inventory.valueDeltaMinor,
              }
            : null,
        };
      }),
      settlements,
      settlementSummary: {
        receivableReductionMinor: plan.settlement.receivableReductionMinor.toString(),
        originalCustomerCreditRestorationMinor:
          plan.settlement.originalCustomerCreditRestorationMinor.toString(),
        refundMinor: plan.settlement.refundMinor.toString(),
        newCustomerCreditMinor: plan.settlement.newCustomerCreditMinor.toString(),
        residualChoice: plan.settlement.residualChoice,
      },
      posting: {
        businessDate: posting.postingDate,
        postingDate: posting.postingDate,
        accountingPeriodId: posting.accountingPeriodId,
      },
    };
  }

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCommand,
    returnId: string,
  ): Promise<SaleReturnPostingResult | null> {
    const prior = await this.readOperation(transaction, context.storeId, command.operationId);
    if (prior) return this.resolveOperation(transaction, context, command, returnId, prior);
    let claimed: boolean;
    try {
      const result = await transaction.transaction((savepoint) =>
        savepoint.execute<{ claimed: boolean }>(sql`
          select sync.claim_operation(
            ${context.storeId}::uuid, ${command.operationId}::uuid, ${context.deviceId}::uuid,
            ${AGGREGATE}, ${returnId}::uuid, ${ACTION}, ${command.requestHash}
          ) as claimed
        `),
      );
      claimed = result.rows[0]?.claimed === true;
    } catch (error) {
      if (postgresqlErrorCode(error) !== '23505') throw error;
      const concurrent = await this.readOperation(
        transaction,
        context.storeId,
        command.operationId,
      );
      if (!concurrent) throw error;
      return this.resolveOperation(transaction, context, command, returnId, concurrent);
    }
    if (claimed) return null;
    const existing = await this.readOperation(transaction, context.storeId, command.operationId);
    if (!existing) throw new Error('Claimed Sale Return operation could not be read.');
    return this.resolveOperation(transaction, context, command, returnId, existing);
  }

  private async readOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperationRow | undefined> {
    const result = await transaction.execute<ProcessedOperationRow>(sql`
      select device_id as "deviceId", aggregate_type as "aggregateType",
        aggregate_id as "aggregateId", action, request_hash as "requestHash", status,
        response_code as "responseCode", response_body as "responseBody", error_code as "errorCode"
      from sync.processed_operations
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SaleReturnCommand,
    returnId: string,
    row: ProcessedOperationRow,
  ): Promise<SaleReturnPostingResult> {
    if (
      row.deviceId !== context.deviceId ||
      row.aggregateType !== AGGREGATE ||
      row.aggregateId !== returnId ||
      row.action !== ACTION ||
      row.requestHash !== command.requestHash
    ) {
      await transaction.execute(sql`
        insert into sync.conflicts(store_id,operation_id,entity_type,entity_id,conflict_type,client_payload)
        values(${context.storeId}::uuid,${command.operationId}::uuid,${AGGREGATE},${returnId}::uuid,
          'duplicate_identity',jsonb_build_object('action',${ACTION}::text,'requestHash',${command.requestHash}::text))
      `);
      return { ok: false, error: failureDefinitions.OPERATION_ID_CONFLICT };
    }
    if (row.status === 'applied') {
      if (row.responseCode !== 201)
        throw new Error('Stored Sale Return response status is invalid.');
      return { ok: true, response: parseStoredSaleReturnPostingResponse(row.responseBody) };
    }
    if (row.status === 'rejected') {
      const code = row.errorCode;
      if (!code || !(code in failureDefinitions)) {
        throw new Error('Stored Sale Return rejection is invalid.');
      }
      const error = failureDefinitions[code as SaleReturnPostingFailureCode];
      const body = row.responseBody;
      if (
        row.responseCode !== error.statusCode ||
        typeof body !== 'object' ||
        body === null ||
        !('code' in body) ||
        body.code !== code ||
        !('message' in body) ||
        typeof body.message !== 'string'
      ) {
        throw new Error('Stored Sale Return rejection status is invalid.');
      }
      return { ok: false, error: { ...error, message: body.message } };
    }
    return { ok: false, error: failureDefinitions.OPERATION_IN_PROGRESS };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SaleReturnPostingResponse,
  ): Promise<void> {
    const result = await transaction.execute(sql`
      update sync.processed_operations
      set status='applied',response_code=201,response_body=${JSON.stringify(response)}::jsonb,
        error_code=null,completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing'
      returning operation_id
    `);
    if (result.rows.length !== 1) throw new Error('Sale Return operation completion failed.');
  }

  private async rejectOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: SaleReturnPostingFailure,
  ): Promise<void> {
    const body = { code: error.code, message: error.message };
    const result = await transaction.execute(sql`
      update sync.processed_operations
      set status='rejected',response_code=${error.statusCode},response_body=${JSON.stringify(body)}::jsonb,
        error_code=${error.code},completed_at=clock_timestamp()
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid and status='processing'
      returning operation_id
    `);
    if (result.rows.length !== 1) throw new Error('Sale Return operation rejection failed.');
  }

  private knownFailure(error: unknown): SaleReturnPostingFailure | null {
    if (error instanceof SaleReturnAuthorityError) return failureDefinitions[error.code];
    if (error instanceof SaleReturnInventoryError) return failureDefinitions[error.code];
    if (error instanceof AccountingPeriodNotPostingEligibleError) {
      return failureDefinitions.ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE;
    }
    if (error instanceof AccountingPeriodIntegrityError) {
      return failureDefinitions.ACCOUNTING_PERIOD_INTEGRITY_CONFLICT;
    }
    if (error instanceof RangeError) return failureDefinitions.SALE_RETURN_AMOUNT_INVALID;
    return null;
  }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new SaleReturnAuthorityError('SALE_RETURN_INTEGRITY_CONFLICT');
  }
  return value;
}

function definition<T extends SaleReturnPostingFailureCode>(
  code: T,
  message: string,
  statusCode: 400 | 404 | 409,
): SaleReturnPostingFailure & { code: T } {
  return { code, message, statusCode };
}
