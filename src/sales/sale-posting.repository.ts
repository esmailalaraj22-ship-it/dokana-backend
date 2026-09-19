import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  AccountingPeriodNotPostingEligibleError,
  AccountingPeriodPostingContextService,
} from '../accounting-periods/accounting-period-posting-context.service';
import type { AccountingPeriodPostingContext } from '../accounting-periods/accounting-period-posting-context.types';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { DatabaseService } from '../database/database.service';
import {
  appSettings,
  customerLedgerEntries,
  customers,
  inventoryMovements,
  products,
  productUnits,
  saleCustomerCreditApplications,
  saleItems,
  salePayments,
  sales,
  stockBalances,
  stores,
} from '../database/schema';
import type { InventoryCostState } from '../database/schema/inventory';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { inventoryBaseQuantity } from '../inventory/inventory-math';
import { inventoryPostingEffect } from '../inventory/inventory-posting-math';
import { postgresqlErrorCode } from '../money-movements/money-movement-database-error';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../money-movements/money-movement-identity';
import { MoneyMovementPostingRepository } from '../money-movements/money-movement-posting.repository';
import type { PostedMoneyMovement } from '../money-movements/money-movement.types';
import type {
  CustomerOpeningReceivableCommand,
  ProductSaleLineCommand,
  SalePostingCommand,
} from './sale-posting-command';
import {
  parseStoredCustomerOpeningReceivableResponse,
  parseStoredSalePostingResponse,
} from './sale-posting-response';
import type {
  CustomerOpeningReceivableResult,
  PostedCustomerReceivable,
  PostedSaleCustomerCreditTender,
  PostedSaleItem,
  PostedSalePayment,
  SalePostingFailure,
  SalePostingFailureCode,
  SalePostingResponse,
  SalePostingResult,
  SalePostingStoredResponse,
} from './sale-posting.types';
import { CustomerReceivableSettlementRepository } from './customer-receivable-settlement.repository';

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
  aggregateType: 'sales' | 'customer_ledger_entries';
  aggregateId: string;
  action: 'sales.post' | 'customer_receivables.opening';
  requestHash: string;
}

interface FailureResult {
  ok: false;
  error: SalePostingFailure;
}

interface LockedCustomer {
  id: string;
  status: 'active' | 'archived';
  creditLimitMinor: bigint | null;
  creditPolicy: 'allow' | 'warn' | 'block' | null;
}

interface LockedProduct {
  id: string;
  name: string;
  measurementType: 'count' | 'weight' | 'volume' | 'length';
  trackInventory: boolean;
  allowNegativeStockOverride: boolean | null;
  status: 'active' | 'archived';
}

interface LockedUnit {
  id: string;
  productId: string;
  unitName: string;
  measurementType: 'count' | 'weight' | 'volume' | 'length';
  factorNum: number;
  factorDen: number;
  status: 'active' | 'archived';
}

const failures: Readonly<Record<SalePostingFailureCode, SalePostingFailure>> = {
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
  CUSTOMER_CREDIT_LIMIT_EXCEEDED: {
    code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
    message: 'Customer credit limit would be exceeded.',
    statusCode: 409,
  },
  CUSTOMER_CREDIT_INSUFFICIENT: {
    code: 'CUSTOMER_CREDIT_INSUFFICIENT',
    message: 'Customer Credit is insufficient.',
    statusCode: 409,
  },
  CUSTOMER_NOT_FOUND: {
    code: 'CUSTOMER_NOT_FOUND',
    message: 'Customer not found.',
    statusCode: 404,
  },
  CUSTOMER_UNAVAILABLE: {
    code: 'CUSTOMER_UNAVAILABLE',
    message: 'Customer is not available for new Sales.',
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
  PRODUCT_NOT_FOUND: {
    code: 'PRODUCT_NOT_FOUND',
    message: 'Product not found.',
    statusCode: 404,
  },
  PRODUCT_UNAVAILABLE: {
    code: 'PRODUCT_UNAVAILABLE',
    message: 'Product is not available for new Sales.',
    statusCode: 409,
  },
  PRODUCT_UNIT_NOT_FOUND: {
    code: 'PRODUCT_UNIT_NOT_FOUND',
    message: 'Product Unit not found.',
    statusCode: 404,
  },
  PRODUCT_UNIT_UNAVAILABLE: {
    code: 'PRODUCT_UNIT_UNAVAILABLE',
    message: 'Product Unit is not available for new Sales.',
    statusCode: 409,
  },
  SALE_AMOUNT_INVALID: {
    code: 'SALE_AMOUNT_INVALID',
    message: 'Sale quantity, cost, or amount is not representable.',
    statusCode: 400,
  },
  SALE_NEGATIVE_STOCK_NOT_ALLOWED: {
    code: 'SALE_NEGATIVE_STOCK_NOT_ALLOWED',
    message: 'Negative inventory is not permitted.',
    statusCode: 409,
  },
};

export class SalePostingRejectedError extends Error {
  constructor(readonly result: FailureResult) {
    super(result.error.message);
    this.name = 'SalePostingRejectedError';
  }
}

function failure(code: SalePostingFailureCode): FailureResult {
  return { ok: false, error: failures[code] };
}

function reject(code: SalePostingFailureCode): never {
  throw new SalePostingRejectedError(failure(code));
}

@Injectable()
export class SalePostingRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly postingContext: AccountingPeriodPostingContextService,
    private readonly moneyMovements: MoneyMovementPostingRepository,
    private readonly receivables: CustomerReceivableSettlementRepository,
  ) {}

  postSale(
    context: TenantTransactionContext,
    command: SalePostingCommand,
    postingDate: string,
  ): Promise<SalePostingResult> {
    const saleId = deriveMoneyFactId(command.operationId, 'sale');
    const operation: MutationOperation = {
      operationId: command.operationId,
      aggregateType: 'sales',
      aggregateId: saleId,
      action: 'sales.post',
      requestHash: command.requestHash,
    };
    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) return begun as SalePostingResult;
      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(
            savepoint,
            context,
            command.operationId,
            postingDate,
          );
          return this.insertSale(savepoint, context, command, posting, saleId, null);
        });
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  postOpeningReceivable(
    context: TenantTransactionContext,
    command: CustomerOpeningReceivableCommand,
    postingDate: string,
  ): Promise<CustomerOpeningReceivableResult> {
    const receivableId = deriveMoneyFactId(command.operationId, 'customer-opening-receivable');
    const operation: MutationOperation = {
      operationId: command.operationId,
      aggregateType: 'customer_ledger_entries',
      aggregateId: receivableId,
      action: 'customer_receivables.opening',
      requestHash: command.requestHash,
    };
    return this.database.withTenantTransaction(context, async (transaction) => {
      const begun = await this.beginMutation(transaction, context, operation);
      if (begun) return begun as CustomerOpeningReceivableResult;
      try {
        const response = await transaction.transaction(async (savepoint) => {
          const posting = await this.resolvePosting(
            savepoint,
            context,
            command.operationId,
            postingDate,
          );
          await this.lockCustomer(savepoint, context.storeId, command.customerId);
          await savepoint.execute(
            sql`select set_config('app.audit_reason', 'Customer opening receivable posted', true)`,
          );
          const receivable = await this.insertReceivable(savepoint, context, {
            id: receivableId,
            operationId: deriveMoneyFactOperationId(
              command.operationId,
              'customer-opening-receivable',
            ),
            customerId: command.customerId,
            accountingPeriodId: posting.accountingPeriodId,
            entryType: 'opening_balance',
            amountMinor: command.amountMinor,
            sourceSaleId: null,
            referenceType: 'customer_opening_receivable',
            referenceId: receivableId,
            transactionGroupId: deriveTransactionGroupId(command.operationId),
            occurredAt: command.occurredAt,
            reason: command.notes,
          });
          return {
            operationId: command.operationId,
            customerId: command.customerId,
            businessDate: posting.postingDate,
            postingDate: posting.postingDate,
            accountingPeriodId: posting.accountingPeriodId,
            receivable,
          };
        });
        await this.applyOperation(transaction, context.storeId, command.operationId, response);
        return { ok: true, response };
      } catch (error) {
        return this.persistKnownRejection(transaction, context.storeId, command.operationId, error);
      }
    });
  }

  insertCorrectionReplacementWithinTransaction(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SalePostingCommand,
    posting: AccountingPeriodPostingContext,
    correctionOfId: string,
  ): Promise<SalePostingResponse> {
    return this.insertSale(
      transaction,
      context,
      command,
      posting,
      deriveMoneyFactId(command.operationId, 'sale'),
      correctionOfId,
    );
  }

  private async insertSale(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SalePostingCommand,
    posting: AccountingPeriodPostingContext,
    saleId: string,
    correctionOfId: string | null,
  ): Promise<SalePostingResponse> {
    const customer =
      command.customerId === null
        ? null
        : await this.lockCustomer(transaction, context.storeId, command.customerId);
    if (command.customerCreditAmountMinor > 0n) {
      if (!customer) reject('CUSTOMER_NOT_FOUND');
      const availableCredit = await this.receivables.readAvailableCredit(
        transaction,
        context.storeId,
        customer.id,
      );
      if (command.customerCreditAmountMinor > availableCredit) {
        reject('CUSTOMER_CREDIT_INSUFFICIENT');
      }
    }
    if (command.creditTotalMinor > 0n) {
      if (!customer) reject('CUSTOMER_NOT_FOUND');
      await this.assertCreditLimit(
        transaction,
        context.storeId,
        customer,
        command.creditTotalMinor,
        command.customerCreditAmountMinor,
      );
    }

    const { lockedProducts, lockedUnits } = await this.lockSaleCatalog(
      transaction,
      context.storeId,
      command,
    );
    try {
      await this.moneyMovements.lockAndValidateAccounts(
        transaction,
        context.storeId,
        command.payments.map((payment) => payment.moneyAccountId),
      );
    } catch (error) {
      if (error instanceof NotFoundException) reject('MONEY_ACCOUNT_NOT_FOUND');
      if (error instanceof ConflictException) reject('MONEY_ACCOUNT_UNAVAILABLE');
      throw error;
    }

    const [settings] = await transaction
      .select({ allowNegativeStock: appSettings.allowNegativeStock })
      .from(appSettings)
      .where(eq(appSettings.storeId, context.storeId))
      .limit(1)
      .for('share');
    const transactionGroupId = deriveTransactionGroupId(command.operationId);
    const displayNumber = `S-${saleId}`;

    await transaction.execute(sql`select set_config('app.audit_reason', 'Sale posted', true)`);
    await transaction.insert(sales).values({
      id: saleId,
      storeId: context.storeId,
      customerId: command.customerId,
      accountingPeriodId: null,
      displayNumber,
      saleAt: command.occurredAt,
      itemsSubtotalMinor: command.itemsSubtotalMinor,
      lineDiscountTotalMinor: command.lineDiscountTotalMinor,
      invoiceDiscountMinor: command.invoiceDiscountMinor,
      roundingMinor: command.roundingMinor,
      totalMinor: command.totalMinor,
      paidTotalMinor: command.paidTotalMinor,
      creditTotalMinor: command.creditTotalMinor,
      knownCostTotalMinor: 0n,
      pendingCostLineCount: 0,
      unknownCostLineCount: 0,
      paymentStatus: command.paymentStatus,
      status: 'draft',
      notes: command.notes,
      correctionOfId,
      deviceId: context.deviceId,
      operationId: command.operationId,
    });

    const postedItems: PostedSaleItem[] = [];
    let knownCostTotalMinor = 0n;
    let pendingCostLineCount = 0;
    let unknownCostLineCount = 0;
    for (const [index, line] of command.items.entries()) {
      const posted = line.isManualLine
        ? await this.insertManualItem(transaction, context, command, saleId, index, line)
        : await this.insertProductItem(
            transaction,
            context,
            command,
            posting,
            saleId,
            index,
            line,
            {
              products: lockedProducts,
              units: lockedUnits,
              allowNegativeStock: settings?.allowNegativeStock ?? false,
            },
          );
      postedItems.push(posted);
      if (posted.costStatus === 'known') {
        knownCostTotalMinor += BigInt(posted.lineCostMinor ?? '0');
        if (knownCostTotalMinor > 9_223_372_036_854_775_807n) reject('SALE_AMOUNT_INVALID');
      } else if (posted.costStatus === 'pending') {
        pendingCostLineCount += 1;
      } else {
        unknownCostLineCount += 1;
      }
    }

    const postedPayments: PostedSalePayment[] = [];
    for (const payment of command.payments) {
      const paymentId = deriveMoneyFactId(
        command.operationId,
        `sale-payment:${payment.moneyAccountId}`,
      );
      const movement = await this.moneyMovements.insertMovementWithinTransaction(
        transaction,
        context,
        {
          commandOperationId: command.operationId,
          discriminator: `sale-payment-money:${payment.moneyAccountId}`,
          accountId: payment.moneyAccountId,
          amountDeltaMinor: payment.amountMinor,
          movementType: 'sale_payment',
          referenceType: 'sale_payment',
          referenceId: paymentId,
          accountingPeriodId: posting.accountingPeriodId,
          occurredAt: command.occurredAt,
          transactionGroupId,
          externalReference: payment.externalReference,
          notes: command.notes,
        },
      );
      await transaction.insert(salePayments).values({
        id: paymentId,
        storeId: context.storeId,
        saleId,
        moneyAccountId: payment.moneyAccountId,
        amountMinor: payment.amountMinor,
        paymentAt: command.occurredAt,
        senderAccountName: payment.senderAccountName,
        externalReference: payment.externalReference,
        moneyMovementId: movement.id,
      });
      postedPayments.push(this.paymentResponse(paymentId, payment, movement));
    }

    const customerCreditTender =
      command.customerCreditAmountMinor === 0n || command.customerId === null
        ? null
        : await this.insertCustomerCreditApplication(transaction, context, {
            command,
            saleId,
            customerId: command.customerId,
            accountingPeriodId: posting.accountingPeriodId,
            transactionGroupId,
          });

    const receivable =
      command.creditTotalMinor === 0n || command.customerId === null
        ? null
        : await this.insertReceivable(transaction, context, {
            id: deriveMoneyFactId(command.operationId, 'sale-receivable'),
            operationId: deriveMoneyFactOperationId(command.operationId, 'sale-receivable'),
            customerId: command.customerId,
            accountingPeriodId: posting.accountingPeriodId,
            entryType: 'sale_credit',
            amountMinor: command.creditTotalMinor,
            sourceSaleId: saleId,
            referenceType: 'sale',
            referenceId: saleId,
            transactionGroupId,
            occurredAt: command.occurredAt,
            reason: command.notes,
          });

    const finalized = await transaction
      .update(sales)
      .set({
        accountingPeriodId: posting.accountingPeriodId,
        knownCostTotalMinor,
        pendingCostLineCount,
        unknownCostLineCount,
        status: 'posted',
      })
      .where(
        and(eq(sales.storeId, context.storeId), eq(sales.id, saleId), eq(sales.status, 'draft')),
      )
      .returning({ version: sales.version });
    const finalizedSale = finalized[0];
    if (!finalizedSale) throw new Error('Sale finalization did not return a row.');

    return {
      operationId: command.operationId,
      businessDate: posting.postingDate,
      postingDate: posting.postingDate,
      accountingPeriodId: posting.accountingPeriodId,
      sale: {
        id: saleId,
        customerId: command.customerId,
        displayNumber,
        occurredAt: command.occurredAt.toISOString(),
        status: 'posted',
        paymentStatus: command.paymentStatus,
        itemsSubtotalMinor: command.itemsSubtotalMinor.toString(),
        lineDiscountTotalMinor: command.lineDiscountTotalMinor.toString(),
        invoiceDiscountMinor: command.invoiceDiscountMinor.toString(),
        roundingMinor: command.roundingMinor.toString(),
        totalMinor: command.totalMinor.toString(),
        paidTotalMinor: command.paidTotalMinor.toString(),
        creditTotalMinor: command.creditTotalMinor.toString(),
        knownCostTotalMinor: knownCostTotalMinor.toString(),
        pendingCostLineCount,
        unknownCostLineCount,
        notes: command.notes,
        version: finalizedSale.version.toString(),
      },
      items: postedItems,
      payments: postedPayments,
      customerCreditTender,
      receivable,
    };
  }

  private async insertManualItem(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SalePostingCommand,
    saleId: string,
    index: number,
    line: Extract<SalePostingCommand['items'][number], { isManualLine: true }>,
  ): Promise<PostedSaleItem> {
    const id = deriveMoneyFactId(command.operationId, `sale-item:${String(index)}`);
    await transaction.insert(saleItems).values({
      id,
      storeId: context.storeId,
      saleId,
      productId: null,
      productUnitId: null,
      isManualLine: true,
      productNameSnapshot: line.description,
      unitNameSnapshot: line.unitName,
      quantityMilli: line.quantityMilli,
      conversionFactorNum: 1,
      conversionFactorDen: 1,
      baseQuantityMilli: null,
      unitPriceMinor: line.unitPriceMinor,
      lineGrossMinor: line.lineGrossMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      roundingMinor: line.roundingMinor,
      lineTotalMinor: line.lineTotalMinor,
      costStatus: 'unknown',
      unitCostMinor: null,
      lineCostMinor: null,
      inventoryMovementId: null,
    });
    return {
      id,
      productId: null,
      productUnitId: null,
      isManualLine: true,
      productName: line.description,
      unitName: line.unitName,
      quantityMilli: line.quantityMilli.toString(),
      conversionFactorNumerator: 1,
      conversionFactorDenominator: 1,
      baseQuantityMilli: null,
      unitPriceMinor: line.unitPriceMinor.toString(),
      lineGrossMinor: line.lineGrossMinor.toString(),
      lineDiscountMinor: line.lineDiscountMinor.toString(),
      roundingMinor: line.roundingMinor.toString(),
      lineTotalMinor: line.lineTotalMinor.toString(),
      costStatus: 'unknown',
      unitCostMinor: null,
      lineCostMinor: null,
      inventoryMovementId: null,
    };
  }

  private async insertProductItem(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    command: SalePostingCommand,
    posting: AccountingPeriodPostingContext,
    saleId: string,
    index: number,
    line: ProductSaleLineCommand,
    locked: {
      products: Map<string, LockedProduct>;
      units: Map<string, LockedUnit>;
      allowNegativeStock: boolean;
    },
  ): Promise<PostedSaleItem> {
    const product = locked.products.get(line.productId);
    const unit = locked.units.get(this.unitKey(line.productId, line.productUnitId));
    if (!product || !unit) throw new Error('Locked Sale catalog state is incomplete.');
    let baseQuantityMilli: bigint;
    try {
      baseQuantityMilli = inventoryBaseQuantity(line.quantityMilli, unit.factorNum, unit.factorDen);
    } catch (error) {
      if (error instanceof RangeError) reject('SALE_AMOUNT_INVALID');
      throw error;
    }
    if (baseQuantityMilli <= 0n) reject('SALE_AMOUNT_INVALID');

    const id = deriveMoneyFactId(command.operationId, `sale-item:${String(index)}`);
    let costStatus: 'known' | 'pending' | 'unknown' = 'unknown';
    let storedUnitCostMinor: bigint | null = null;
    let storedLineCostMinor: bigint | null = null;
    let responseUnitCostMinor: string | null = null;
    let responseLineCostMinor: string | null = null;
    let inventoryMovementId: string | null = null;

    if (product.trackInventory) {
      const [balance] = await transaction
        .select({
          quantityMilli: stockBalances.quantityMilli,
          inventoryValueMinor: stockBalances.inventoryValueMinor,
          averageUnitCostMinor: stockBalances.averageUnitCostMinor,
          costState: stockBalances.costState,
        })
        .from(stockBalances)
        .where(
          and(eq(stockBalances.storeId, context.storeId), eq(stockBalances.productId, product.id)),
        )
        .limit(1);
      const before = balance ?? {
        quantityMilli: 0n,
        inventoryValueMinor: 0n,
        averageUnitCostMinor: 0n,
        costState: 'known' as InventoryCostState,
      };
      let effect: ReturnType<typeof inventoryPostingEffect>;
      try {
        effect = inventoryPostingEffect(before, -baseQuantityMilli, null);
      } catch (error) {
        if (error instanceof RangeError) reject('SALE_AMOUNT_INVALID');
        throw error;
      }
      if (
        effect.quantityAfterMilli < 0n &&
        !(product.allowNegativeStockOverride ?? locked.allowNegativeStock)
      ) {
        reject('SALE_NEGATIVE_STOCK_NOT_ALLOWED');
      }
      costStatus = effect.costStatus;
      storedLineCostMinor =
        costStatus === 'unknown'
          ? null
          : before.inventoryValueMinor - effect.inventoryValueAfterMinor;
      storedUnitCostMinor = costStatus === 'known' ? before.averageUnitCostMinor : null;
      responseUnitCostMinor = storedUnitCostMinor?.toString() ?? null;
      responseLineCostMinor =
        costStatus === 'known' ? (storedLineCostMinor?.toString() ?? null) : null;
      inventoryMovementId = deriveMoneyFactId(
        command.operationId,
        `sale-item:${String(index)}:inventory`,
      );
      await transaction.insert(inventoryMovements).values({
        id: inventoryMovementId,
        storeId: context.storeId,
        productId: product.id,
        productUnitId: unit.id,
        accountingPeriodId: posting.accountingPeriodId,
        movementType: 'sale',
        quantityBeforeMilli: before.quantityMilli,
        quantityDeltaMilli: -baseQuantityMilli,
        quantityAfterMilli: effect.quantityAfterMilli,
        inventoryValueBeforeMinor: before.inventoryValueMinor,
        valueDeltaMinor: effect.valueDeltaMinor,
        inventoryValueAfterMinor: effect.inventoryValueAfterMinor,
        averageUnitCostAfterMinor: effect.averageUnitCostAfterMinor,
        costStatus: effect.costStatus,
        hasPendingCostAfter: effect.hasPendingCostAfter,
        referenceType: 'sale',
        referenceId: saleId,
        transactionGroupId: deriveTransactionGroupId(command.operationId),
        occurredAt: command.occurredAt,
        reason: command.notes,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(
          command.operationId,
          `sale-item:${String(index)}:inventory`,
        ),
        selectedQuantityMilli: line.quantityMilli,
        factorNum: unit.factorNum,
        factorDen: unit.factorDen,
        businessDate: posting.postingDate,
        postingDate: posting.postingDate,
        costStateBefore: before.costState,
        costStateAfter: effect.costStateAfter,
      });
    }

    await transaction.insert(saleItems).values({
      id,
      storeId: context.storeId,
      saleId,
      productId: product.id,
      productUnitId: unit.id,
      isManualLine: false,
      productNameSnapshot: product.name,
      unitNameSnapshot: unit.unitName,
      quantityMilli: line.quantityMilli,
      conversionFactorNum: unit.factorNum,
      conversionFactorDen: unit.factorDen,
      baseQuantityMilli,
      unitPriceMinor: line.unitPriceMinor,
      lineGrossMinor: line.lineGrossMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      roundingMinor: line.roundingMinor,
      lineTotalMinor: line.lineTotalMinor,
      costStatus,
      unitCostMinor: storedUnitCostMinor,
      lineCostMinor: storedLineCostMinor,
      inventoryMovementId,
    });
    return {
      id,
      productId: product.id,
      productUnitId: unit.id,
      isManualLine: false,
      productName: product.name,
      unitName: unit.unitName,
      quantityMilli: line.quantityMilli.toString(),
      conversionFactorNumerator: unit.factorNum,
      conversionFactorDenominator: unit.factorDen,
      baseQuantityMilli: baseQuantityMilli.toString(),
      unitPriceMinor: line.unitPriceMinor.toString(),
      lineGrossMinor: line.lineGrossMinor.toString(),
      lineDiscountMinor: line.lineDiscountMinor.toString(),
      roundingMinor: line.roundingMinor.toString(),
      lineTotalMinor: line.lineTotalMinor.toString(),
      costStatus,
      unitCostMinor: responseUnitCostMinor,
      lineCostMinor: responseLineCostMinor,
      inventoryMovementId,
    };
  }

  private async lockSaleCatalog(
    transaction: DatabaseTransaction,
    storeId: string,
    command: SalePostingCommand,
  ): Promise<{ lockedProducts: Map<string, LockedProduct>; lockedUnits: Map<string, LockedUnit> }> {
    const productLines = command.items.filter(
      (line): line is ProductSaleLineCommand => !line.isManualLine,
    );
    const productIds = [...new Set(productLines.map((line) => line.productId))].sort();
    const lockedProducts = new Map<string, LockedProduct>();
    for (const productId of productIds) {
      const [product] = await transaction
        .select({
          id: products.id,
          name: products.name,
          measurementType: products.measurementType,
          trackInventory: products.trackInventory,
          allowNegativeStockOverride: products.allowNegativeStockOverride,
          status: products.status,
        })
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.id, productId)))
        .limit(1)
        .for('update');
      if (!product) reject('PRODUCT_NOT_FOUND');
      if (product.status !== 'active') reject('PRODUCT_UNAVAILABLE');
      lockedProducts.set(productId, product);
    }

    const unitPairs = [
      ...new Map(
        productLines.map((line) => [this.unitKey(line.productId, line.productUnitId), line]),
      ).values(),
    ].sort((left, right) => {
      const leftKey = this.unitKey(left.productId, left.productUnitId);
      const rightKey = this.unitKey(right.productId, right.productUnitId);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const lockedUnits = new Map<string, LockedUnit>();
    for (const line of unitPairs) {
      const [unit] = await transaction
        .select({
          id: productUnits.id,
          productId: productUnits.productId,
          unitName: productUnits.unitName,
          measurementType: productUnits.measurementType,
          factorNum: productUnits.factorNum,
          factorDen: productUnits.factorDen,
          status: productUnits.status,
        })
        .from(productUnits)
        .where(
          and(
            eq(productUnits.storeId, storeId),
            eq(productUnits.productId, line.productId),
            eq(productUnits.id, line.productUnitId),
          ),
        )
        .limit(1)
        .for('share');
      if (!unit) reject('PRODUCT_UNIT_NOT_FOUND');
      const product = lockedProducts.get(line.productId);
      if (!product) throw new Error('Locked Sale Product is missing.');
      if (unit.status !== 'active' || unit.measurementType !== product.measurementType) {
        reject('PRODUCT_UNIT_UNAVAILABLE');
      }
      lockedUnits.set(this.unitKey(line.productId, line.productUnitId), unit);
    }
    return { lockedProducts, lockedUnits };
  }

  private async lockCustomer(
    transaction: DatabaseTransaction,
    storeId: string,
    customerId: string,
  ): Promise<LockedCustomer> {
    const [customer] = await transaction
      .select({
        id: customers.id,
        status: customers.status,
        creditLimitMinor: customers.creditLimitMinor,
        creditPolicy: customers.creditPolicy,
      })
      .from(customers)
      .where(and(eq(customers.storeId, storeId), eq(customers.id, customerId)))
      .limit(1)
      .for('update');
    if (!customer) reject('CUSTOMER_NOT_FOUND');
    if (customer.status !== 'active') reject('CUSTOMER_UNAVAILABLE');
    return customer;
  }

  private async assertCreditLimit(
    transaction: DatabaseTransaction,
    storeId: string,
    customer: LockedCustomer,
    newReceivable: bigint,
    consumedCredit: bigint,
  ): Promise<void> {
    const [settings] = await transaction
      .select({
        defaultCreditPolicy: appSettings.defaultCreditPolicy,
        defaultCreditLimitMinor: appSettings.defaultCreditLimitMinor,
      })
      .from(appSettings)
      .where(eq(appSettings.storeId, storeId))
      .limit(1)
      .for('share');
    const policy = customer.creditPolicy ?? settings?.defaultCreditPolicy ?? 'warn';
    const limit = customer.creditLimitMinor ?? settings?.defaultCreditLimitMinor ?? null;
    if (policy !== 'block' || limit === null) return;
    const outstanding = await transaction.execute<{ amount: string }>(sql`
      select coalesce(sum(receivable_delta_minor - credit_delta_minor), 0)::text as amount
      from ledger.customer_ledger_entries
      where store_id=${storeId}::uuid and customer_id=${customer.id}::uuid
    `);
    if (BigInt(outstanding.rows[0]?.amount ?? '0') + consumedCredit + newReceivable > limit) {
      reject('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
    }
  }

  private async insertCustomerCreditApplication(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: {
      command: SalePostingCommand;
      saleId: string;
      customerId: string;
      accountingPeriodId: string;
      transactionGroupId: string;
    },
  ): Promise<PostedSaleCustomerCreditTender> {
    const ledgerDiscriminator = 'sale-customer-credit-ledger';
    const ledgerEntryId = deriveMoneyFactId(input.command.operationId, ledgerDiscriminator);
    const ledgerRows = await transaction
      .insert(customerLedgerEntries)
      .values({
        id: ledgerEntryId,
        storeId: context.storeId,
        customerId: input.customerId,
        accountingPeriodId: input.accountingPeriodId,
        entryType: 'credit_used',
        receivableDeltaMinor: 0n,
        creditDeltaMinor: -input.command.customerCreditAmountMinor,
        sourceSaleId: input.saleId,
        referenceType: 'sale',
        referenceId: input.saleId,
        transactionGroupId: input.transactionGroupId,
        occurredAt: input.command.occurredAt,
        reason: input.command.notes,
        deviceId: context.deviceId,
        operationId: deriveMoneyFactOperationId(input.command.operationId, ledgerDiscriminator),
      })
      .returning({ createdAt: customerLedgerEntries.createdAt });
    if (!ledgerRows[0]) {
      throw new Error('Sale Customer Credit ledger insertion did not return a row.');
    }

    const applicationId = deriveMoneyFactId(
      input.command.operationId,
      'sale-customer-credit-application',
    );
    const applicationRows = await transaction
      .insert(saleCustomerCreditApplications)
      .values({
        id: applicationId,
        storeId: context.storeId,
        saleId: input.saleId,
        customerId: input.customerId,
        customerLedgerEntryId: ledgerEntryId,
        amountMinor: input.command.customerCreditAmountMinor,
        appliedAt: input.command.occurredAt,
      })
      .returning({ createdAt: saleCustomerCreditApplications.createdAt });
    const application = applicationRows[0];
    if (!application) {
      throw new Error('Sale Customer Credit application insertion did not return a row.');
    }
    return {
      id: applicationId,
      customerId: input.customerId,
      amountMinor: input.command.customerCreditAmountMinor.toString(),
      customerLedgerEntryId: ledgerEntryId,
      appliedAt: input.command.occurredAt.toISOString(),
      createdAt: application.createdAt.toISOString(),
    };
  }

  private async insertReceivable(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    input: {
      id: string;
      operationId: string;
      customerId: string;
      accountingPeriodId: string;
      entryType: 'sale_credit' | 'opening_balance';
      amountMinor: bigint;
      sourceSaleId: string | null;
      referenceType: string;
      referenceId: string;
      transactionGroupId: string;
      occurredAt: Date;
      reason: string | null;
    },
  ): Promise<PostedCustomerReceivable> {
    const rows = await transaction
      .insert(customerLedgerEntries)
      .values({
        id: input.id,
        storeId: context.storeId,
        customerId: input.customerId,
        accountingPeriodId: input.accountingPeriodId,
        entryType: input.entryType,
        receivableDeltaMinor: input.amountMinor,
        creditDeltaMinor: 0n,
        sourceSaleId: input.sourceSaleId,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        transactionGroupId: input.transactionGroupId,
        occurredAt: input.occurredAt,
        reason: input.reason,
        deviceId: context.deviceId,
        operationId: input.operationId,
      })
      .returning({
        id: customerLedgerEntries.id,
        customerId: customerLedgerEntries.customerId,
        entryType: customerLedgerEntries.entryType,
        receivableDeltaMinor: customerLedgerEntries.receivableDeltaMinor,
        creditDeltaMinor: customerLedgerEntries.creditDeltaMinor,
        sourceSaleId: customerLedgerEntries.sourceSaleId,
        transactionGroupId: customerLedgerEntries.transactionGroupId,
        occurredAt: customerLedgerEntries.occurredAt,
        operationId: customerLedgerEntries.operationId,
        createdAt: customerLedgerEntries.createdAt,
      });
    const row = rows[0];
    if (!row || (row.entryType !== 'sale_credit' && row.entryType !== 'opening_balance')) {
      throw new Error('Customer receivable insertion did not return a valid row.');
    }
    return {
      id: row.id,
      customerId: row.customerId,
      entryType: row.entryType,
      receivableDeltaMinor: row.receivableDeltaMinor.toString(),
      creditDeltaMinor: row.creditDeltaMinor.toString(),
      sourceSaleId: row.sourceSaleId,
      transactionGroupId: row.transactionGroupId,
      occurredAt: row.occurredAt.toISOString(),
      operationId: row.operationId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private paymentResponse(
    id: string,
    payment: SalePostingCommand['payments'][number],
    movement: PostedMoneyMovement,
  ): PostedSalePayment {
    return {
      id,
      moneyAccountId: payment.moneyAccountId,
      amountMinor: payment.amountMinor.toString(),
      senderAccountName: payment.senderAccountName,
      externalReference: payment.externalReference,
      moneyMovementId: movement.id,
    };
  }

  private unitKey(productId: string, unitId: string): string {
    return `${productId}:${unitId}`;
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

  private async beginMutation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
  ): Promise<{ ok: true; response: SalePostingStoredResponse } | FailureResult | null> {
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
            ${context.storeId}::uuid, ${operation.operationId}::uuid,
            ${context.deviceId}::uuid, ${operation.aggregateType},
            ${operation.aggregateId}::uuid, ${operation.action}, ${operation.requestHash}
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
    if (!existing) throw new Error('Claimed Sale operation could not be read.');
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
      where store_id=${storeId}::uuid and operation_id=${operationId}::uuid
    `);
    return result.rows[0];
  }

  private async resolveProcessedOperation(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    operation: MutationOperation,
    existing: ProcessedOperationRow,
  ): Promise<{ ok: true; response: SalePostingStoredResponse } | FailureResult> {
    if (
      existing.deviceId !== context.deviceId ||
      existing.aggregateType !== operation.aggregateType ||
      existing.aggregateId !== operation.aggregateId ||
      existing.action !== operation.action ||
      existing.requestHash !== operation.requestHash
    ) {
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
      return failure('OPERATION_ID_CONFLICT');
    }
    if (existing.status === 'applied') {
      if (existing.responseCode !== 201) throw new Error('Stored Sale posting status is invalid.');
      return {
        ok: true,
        response:
          operation.action === 'sales.post'
            ? parseStoredSalePostingResponse(existing.responseBody)
            : parseStoredCustomerOpeningReceivableResponse(existing.responseBody),
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
      !(code in failures) ||
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      !('code' in body) ||
      body.code !== code ||
      !('message' in body) ||
      typeof body.message !== 'string'
    ) {
      throw new Error('Stored Sale posting rejection is invalid.');
    }
    const definition = failures[code as SalePostingFailureCode];
    if (existing.responseCode !== definition.statusCode) {
      throw new Error('Stored Sale posting rejection status is invalid.');
    }
    return { ok: false, error: { ...definition, message: body.message } };
  }

  private async applyOperation(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    response: SalePostingStoredResponse,
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
    if (completed.rows.length !== 1) throw new Error('Sale operation completion failed.');
  }

  private async persistKnownRejection(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    error: unknown,
  ): Promise<FailureResult> {
    if (!(error instanceof SalePostingRejectedError)) throw error;
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
    if (completed.rows.length !== 1) throw new Error('Sale operation rejection failed.');
    return error.result;
  }
}
