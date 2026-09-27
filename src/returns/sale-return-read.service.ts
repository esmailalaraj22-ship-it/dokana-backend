import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ListSaleReturnsQueryDto } from './dto/list-sale-returns-query.dto';
import {
  assertSaleReturnReadCursorScope,
  decodeSaleReturnReadCursor,
  encodeSaleReturnReadCursor,
  saleReturnReadCursorScopeHash,
} from './sale-return-read-cursor';
import { SaleReturnReadQueryError } from './sale-return-read-query-error';
import { SaleReturnReadRepository } from './sale-return-read.repository';
import type {
  SaleReturnCustomerResponse,
  SaleReturnDetailResponse,
  SaleReturnDetailRow,
  SaleReturnEligibilityResponse,
  SaleReturnEligibilityRow,
  SaleReturnLineReadResponse,
  SaleReturnListResponse,
  SaleReturnReadCustomerRow,
  SaleReturnSettlementEffectResponse,
  SaleReturnSettlementReadRow,
  SaleReturnSummaryResponse,
  SaleReturnSummaryRow,
} from './sale-return-read.types';
import { CUSTOMER_RETURN_WINDOW_MS } from './sale-return.types';

type SaleReturnReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SaleReturnReadService {
  constructor(private readonly repository: SaleReturnReadRepository) {}

  list(
    principal: SaleReturnReadPrincipal,
    context: TenantTransactionContext,
    query: ListSaleReturnsQueryDto,
  ): Promise<SaleReturnListResponse> {
    return this.listScoped(principal, context, null, query);
  }

  listForSale(
    principal: SaleReturnReadPrincipal,
    context: TenantTransactionContext,
    saleIdInput: string,
    query: ListSaleReturnsQueryDto,
  ): Promise<SaleReturnListResponse> {
    return this.listScoped(principal, context, this.canonicalUuid(saleIdInput, 'saleId'), query);
  }

  async getById(
    principal: SaleReturnReadPrincipal,
    context: TenantTransactionContext,
    returnIdInput: string,
  ): Promise<SaleReturnDetailResponse> {
    this.assertAuthorized(principal, context);
    const returnId = this.canonicalUuid(returnIdInput, 'returnId');
    const row = await this.repository.findById(context, returnId);
    if (!row) {
      throw new NotFoundException({
        code: 'SALE_RETURN_NOT_FOUND',
        message: 'Sale Return not found.',
      });
    }
    return this.mapDetail(row);
  }

  async getEligibility(
    principal: SaleReturnReadPrincipal,
    context: TenantTransactionContext,
    saleIdInput: string,
  ): Promise<SaleReturnEligibilityResponse> {
    this.assertAuthorized(principal, context);
    const saleId = this.canonicalUuid(saleIdInput, 'saleId');
    const row = await this.repository.findEligibility(context, saleId);
    if (!row) {
      throw new NotFoundException({ code: 'SALE_NOT_FOUND', message: 'Sale not found.' });
    }
    return this.mapEligibility(row);
  }

  private async listScoped(
    principal: SaleReturnReadPrincipal,
    context: TenantTransactionContext,
    saleId: string | null,
    query: ListSaleReturnsQueryDto,
  ): Promise<SaleReturnListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeSaleReturnReadCursor(query.cursor) : null;
      if (cursor) assertSaleReturnReadCursorScope(cursor, saleId);
      const rows = await this.repository.list(context, {
        anchor: cursor?.anchor ?? null,
        limit,
        saleId,
      });
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const lastRow = pageRows.at(-1);
      return {
        items: pageRows.map((row) => this.mapSummary(row)),
        nextCursor:
          hasNextPage && lastRow
            ? encodeSaleReturnReadCursor({
                scopeHash: saleReturnReadCursorScopeHash(saleId),
                anchor: { id: lastRow.id, version: lastRow.version },
              })
            : null,
      };
    } catch (error) {
      if (error instanceof SaleReturnReadQueryError) {
        throw this.validationException(error.field, error.constraint);
      }
      throw error;
    }
  }

  private mapSummary(row: SaleReturnSummaryRow): SaleReturnSummaryResponse {
    return {
      id: row.id,
      displayNumber: row.displayNumber,
      originalSale: { id: row.saleId, displayNumber: row.saleDisplayNumber },
      customer: row.customer ? this.mapCustomer(row.customer) : null,
      isAnonymous: row.customer === null,
      occurredAt: row.returnAt.toISOString(),
      businessDate: row.postingSnapshot.posting.businessDate,
      postingDate: row.postingSnapshot.posting.postingDate,
      accountingPeriodId: row.accountingPeriodId,
      totalMinor: row.totalMinor.toString(),
      reason: row.reason,
      lifecycle: {
        status: row.status,
        effective: row.status === 'posted',
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        version: row.version.toString(),
      },
      settlementSummary: {
        receivableReductionMinor: row.settlementSummary.receivableReductionMinor.toString(),
        restoredHistoricalCustomerCreditMinor:
          row.settlementSummary.originalCustomerCreditRestorationMinor.toString(),
        newCustomerCreditMinor: row.settlementSummary.newCustomerCreditMinor.toString(),
        moneyRefundMinor: row.settlementSummary.refundMinor.toString(),
      },
      dispositionSummary: row.dispositionSummary,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapDetail(row: SaleReturnDetailRow): SaleReturnDetailResponse {
    const receivable = this.settlement(row, 'receivable_reduction');
    const restored = this.settlement(row, 'original_customer_credit_restoration');
    const newCredit = this.settlement(row, 'new_customer_credit');
    const refund = this.settlement(row, 'money_refund');
    const settlementTotalMinor = row.settlements.reduce(
      (sum, settlement) => sum + settlement.amountMinor,
      0n,
    );
    return {
      return: this.mapSummary(row),
      originalSale: {
        id: row.saleId,
        displayNumber: row.saleDisplayNumber,
        occurredAt: row.saleAt.toISOString(),
        customer: row.customer ? this.mapCustomer(row.customer) : null,
        isAnonymous: row.customer === null,
        status: row.saleStatus,
        correctionOfId: row.saleCorrectionOfId,
        reversedById: row.saleReversedById,
      },
      lines: row.lines.map((line) => this.mapLine(line)),
      settlementTrace: {
        receivableReduction: receivable ? this.mapCustomerEffect(receivable) : null,
        restoredHistoricalCustomerCredit: restored ? this.mapCustomerEffect(restored) : null,
        newCustomerCredit: newCredit ? this.mapCustomerEffect(newCredit) : null,
        moneyRefund:
          refund?.moneyAccount && refund.moneyRefundEffect
            ? {
                settlementId: refund.id,
                amountMinor: refund.amountMinor.toString(),
                moneyAccount: refund.moneyAccount,
                moneyMovement: {
                  id: refund.moneyRefundEffect.id,
                  operationId: refund.moneyRefundEffect.operationId,
                  amountDeltaMinor: refund.moneyRefundEffect.amountDeltaMinor.toString(),
                  occurredAt: refund.moneyRefundEffect.occurredAt.toISOString(),
                },
              }
            : null,
        reconciliation: {
          returnTotalMinor: row.totalMinor.toString(),
          settlementTotalMinor: settlementTotalMinor.toString(),
          reconciled: true,
        },
      },
      lineage: {
        operationId: row.operationId,
        transactionGroupId: row.postingSnapshot.transactionGroupId,
      },
    };
  }

  private mapLine(line: SaleReturnDetailRow['lines'][number]): SaleReturnLineReadResponse {
    return {
      id: line.id,
      originalSaleLineId: line.saleItemId,
      productId: line.productId,
      productUnitId: line.productUnitId,
      isManualLine: line.isManualLine,
      historicalProductName: line.productNameSnapshot,
      historicalUnitName: line.unitNameSnapshot,
      currentProductStatus: line.productStatus,
      currentProductUnitStatus: line.productUnitStatus,
      quantityMilli: line.quantityMilli.toString(),
      baseQuantityMilli: line.baseQuantityMilli?.toString() ?? null,
      historicalReturnValueMinor: line.lineRefundMinor.toString(),
      disposition: line.disposition,
      inventoryQuantityEffectMilli: line.inventoryEffect?.quantityDeltaMilli.toString() ?? '0',
      inventoryMovement: line.inventoryEffect
        ? {
            id: line.inventoryEffect.id,
            operationId: line.inventoryEffect.operationId,
            valueDeltaMinor: line.inventoryEffect.valueDeltaMinor.toString(),
            costStatus: line.inventoryEffect.costStatus,
            occurredAt: line.inventoryEffect.occurredAt.toISOString(),
            businessDate: line.inventoryEffect.businessDate,
            postingDate: line.inventoryEffect.postingDate,
          }
        : null,
      historicalCost: {
        state: line.costStatus,
        returnedCostMinor: line.historicalCostMinor?.toString() ?? null,
        cogsReversalMinor: line.cogsReversalMinor?.toString() ?? null,
      },
    };
  }

  private mapCustomerEffect(
    settlement: SaleReturnSettlementReadRow,
  ): SaleReturnSettlementEffectResponse {
    const effect = settlement.customerLedgerEffect;
    if (!effect) throw new Error('Sale Return Customer settlement effect is missing.');
    return {
      settlementId: settlement.id,
      amountMinor: settlement.amountMinor.toString(),
      customerLedgerEntryId: effect.id,
      customerLedgerOperationId: effect.operationId,
    };
  }

  private settlement(
    row: SaleReturnDetailRow,
    kind: SaleReturnSettlementReadRow['kind'],
  ): SaleReturnSettlementReadRow | undefined {
    return row.settlements.find((settlement) => settlement.kind === kind);
  }

  private mapEligibility(row: SaleReturnEligibilityRow): SaleReturnEligibilityResponse {
    const activeLeaf = row.saleStatus === 'posted' && row.saleReversedById === null;
    const returnableUntil = new Date(row.saleAt.getTime() + CUSTOMER_RETURN_WINDOW_MS);
    const returnWindowOpen =
      row.acceptedAt.getTime() >= row.saleAt.getTime() &&
      row.acceptedAt.getTime() <= returnableUntil.getTime();
    const totalRemainingReturnableValueMinor = row.lines.reduce(
      (sum, line) => sum + line.remainingHistoricalValueMinor,
      0n,
    );
    return {
      sale: {
        id: row.saleId,
        displayNumber: row.saleDisplayNumber,
        occurredAt: row.saleAt.toISOString(),
        customer: row.customer ? this.mapCustomer(row.customer) : null,
        isAnonymous: row.customer === null,
        activeLeaf,
      },
      returnableUntil: returnableUntil.toISOString(),
      returnWindowOpen,
      currentlyReturnable:
        activeLeaf &&
        returnWindowOpen &&
        row.lines.some((line) => line.remainingQuantityMilli > 0n),
      totalRemainingReturnableValueMinor: totalRemainingReturnableValueMinor.toString(),
      lines: row.lines.map((line) => ({
        saleItemId: line.saleItemId,
        productId: line.productId,
        productUnitId: line.productUnitId,
        isManualLine: line.isManualLine,
        historicalProductName: line.productNameSnapshot,
        historicalUnitName: line.unitNameSnapshot,
        originalQuantityMilli: line.originalQuantityMilli.toString(),
        returnedQuantityMilli: line.returnedQuantityMilli.toString(),
        remainingQuantityMilli: line.remainingQuantityMilli.toString(),
        historicalNetValueMinor: line.historicalNetValueMinor.toString(),
        returnedHistoricalValueMinor: line.returnedHistoricalValueMinor.toString(),
        remainingHistoricalValueMinor: line.remainingHistoricalValueMinor.toString(),
        wasInventoryTracked: line.wasInventoryTracked,
        currentRestockSaleableAllowed: line.currentRestockSaleableAllowed,
      })),
    };
  }

  private mapCustomer(row: SaleReturnReadCustomerRow): SaleReturnCustomerResponse {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  private assertAuthorized(
    principal: SaleReturnReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SALE_RETURN_READ_NOT_ALLOWED',
        message: 'Sale Return reads are not allowed.',
      });
    }
  }

  private canonicalUuid(value: string, field: string): string {
    if (!isUUID(value)) throw this.validationException(field, 'isUuid');
    return value.toLowerCase();
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
