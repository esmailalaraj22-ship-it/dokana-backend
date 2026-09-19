import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { ListCustomerReceivablesQueryDto } from './dto/list-customer-receivables-query.dto';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto';
import {
  assertCustomerReceivableCursorScope,
  assertSaleReadCursorScope,
  customerReceivableCursorScopeHash,
  decodeCustomerReceivableCursor,
  decodeSaleReadCursor,
  encodeCustomerReceivableCursor,
  encodeSaleReadCursor,
  saleReadCursorScopeHash,
} from './sale-read-cursor';
import { SaleReadQueryError } from './sale-read-query-error';
import { SaleReadRepository } from './sale-read.repository';
import type {
  CustomerReceivableListResponse,
  CustomerReceivableResponse,
  CustomerReceivableRow,
  SaleDetailResponse,
  SaleDetailRow,
  SaleCustomerCreditTenderReadResponse,
  SaleCustomerCreditTenderReadRow,
  SaleItemReadResponse,
  SaleItemReadRow,
  SaleListResponse,
  SaleReadCustomerResponse,
  SaleReadCustomerRow,
  SaleSummaryResponse,
  SaleSummaryRow,
  SaleTenderReadResponse,
  SaleTenderReadRow,
} from './sale-read.types';

type SaleReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SaleReadService {
  constructor(
    private readonly repository: SaleReadRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async list(
    principal: SaleReadPrincipal,
    context: TenantTransactionContext,
    query: ListSalesQueryDto,
  ): Promise<SaleListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeSaleReadCursor(query.cursor) : null;
      if (cursor) assertSaleReadCursorScope(cursor);
      const rows = await this.repository.list(context, {
        anchor: cursor?.anchor ?? null,
        limit,
      });
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const lastRow = pageRows.at(-1);
      return {
        items: pageRows.map((row) => this.mapSummary(row)),
        nextCursor:
          hasNextPage && lastRow
            ? encodeSaleReadCursor({
                scopeHash: saleReadCursorScopeHash(),
                anchor: { id: lastRow.id, version: lastRow.version },
              })
            : null,
      };
    } catch (error) {
      this.rethrowQueryError(error);
    }
  }

  async getById(
    principal: SaleReadPrincipal,
    context: TenantTransactionContext,
    saleIdInput: string,
  ): Promise<SaleDetailResponse> {
    this.assertAuthorized(principal, context);
    const saleId = this.canonicalUuid(saleIdInput, 'saleId');
    const row = await this.repository.findById(context, saleId);
    if (!row) {
      throw new NotFoundException({ code: 'SALE_NOT_FOUND', message: 'Sale not found.' });
    }
    return this.mapDetail(row);
  }

  async listCustomerReceivables(
    principal: SaleReadPrincipal,
    context: TenantTransactionContext,
    customerIdInput: string,
    query: ListCustomerReceivablesQueryDto,
  ): Promise<CustomerReceivableListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const customerId = this.canonicalUuid(customerIdInput, 'customerId');
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeCustomerReceivableCursor(query.cursor) : null;
      if (cursor) assertCustomerReceivableCursorScope(cursor, customerId);
      const result = await this.repository.readCustomerReceivables(context, customerId, {
        anchor: cursor?.anchor ?? null,
        limit,
      });
      if (!result) {
        throw new NotFoundException({
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found.',
        });
      }
      const hasNextPage = result.receivables.length > limit;
      const pageRows = hasNextPage ? result.receivables.slice(0, limit) : result.receivables;
      const lastRow = pageRows.at(-1);
      return {
        customer: this.mapCustomer(result.customer),
        outstandingMinor: result.customer.outstandingMinor.toString(),
        receivables: pageRows.map((row) => this.mapReceivable(row)),
        nextCursor:
          hasNextPage && lastRow
            ? encodeCustomerReceivableCursor({
                scopeHash: customerReceivableCursorScopeHash(customerId),
                anchor: { id: lastRow.id },
              })
            : null,
      };
    } catch (error) {
      this.rethrowQueryError(error);
    }
  }

  private assertAuthorized(principal: SaleReadPrincipal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SALE_READ_NOT_ALLOWED',
        message: 'Sale reads are not allowed.',
      });
    }
  }

  private mapDetail(row: SaleDetailRow): SaleDetailResponse {
    return {
      sale: {
        ...this.mapSummary(row),
        itemsSubtotalMinor: row.itemsSubtotalMinor.toString(),
        lineDiscountTotalMinor: row.lineDiscountTotalMinor.toString(),
        invoiceDiscountMinor: row.invoiceDiscountMinor.toString(),
        roundingMinor: row.roundingMinor.toString(),
        knownCostTotalMinor: row.knownCostTotalMinor.toString(),
        pendingCostLineCount: row.pendingCostLineCount,
        unknownCostLineCount: row.unknownCostLineCount,
        notes: row.notes,
        correctionOfId: row.correctionOfId,
        reversedById: row.reversedById,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
      },
      items: row.items.map((item) => this.mapItem(item)),
      tenders: row.tenders.map((tender) => this.mapTender(tender)),
      customerCreditTender: row.customerCreditTender
        ? this.mapCustomerCreditTender(row.customerCreditTender)
        : null,
      receivable: row.receivable ? this.mapReceivable(row.receivable) : null,
    };
  }

  private mapSummary(row: SaleSummaryRow): SaleSummaryResponse {
    const businessDate = this.operationalTime.resolve(row.occurredAt).businessDate;
    return {
      id: row.id,
      displayNumber: row.displayNumber,
      occurredAt: row.occurredAt.toISOString(),
      businessDate,
      postingDate: businessDate,
      accountingPeriodId: row.accountingPeriodId,
      customer: row.customer ? this.mapCustomer(row.customer) : null,
      isAnonymous: row.customer === null,
      status: row.status,
      paymentStatus: row.paymentStatus,
      totalMinor: row.totalMinor.toString(),
      moneyPaidTotalMinor: row.moneyPaidTotalMinor.toString(),
      customerCreditUsedMinor: row.customerCreditUsedMinor.toString(),
      paidTotalMinor: row.paidTotalMinor.toString(),
      receivableOriginatedMinor: row.creditTotalMinor.toString(),
      receivableOutstandingMinor: row.receivableOutstandingMinor.toString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapCustomer(row: SaleReadCustomerRow): SaleReadCustomerResponse {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  private mapItem(row: SaleItemReadRow): SaleItemReadResponse {
    const hidesUncertainCost = row.costStatus === 'unknown' || row.costStatus === 'pending';
    return {
      id: row.id,
      productId: row.productId,
      productUnitId: row.productUnitId,
      isManualLine: row.isManualLine,
      productName: row.productNameSnapshot,
      unitName: row.unitNameSnapshot,
      quantityMilli: row.quantityMilli.toString(),
      conversionFactorNumerator: row.conversionFactorNum,
      conversionFactorDenominator: row.conversionFactorDen,
      baseQuantityMilli: row.baseQuantityMilli?.toString() ?? null,
      unitPriceMinor: row.unitPriceMinor.toString(),
      lineGrossMinor: row.lineGrossMinor.toString(),
      lineDiscountMinor: row.lineDiscountMinor.toString(),
      roundingMinor: row.roundingMinor.toString(),
      lineTotalMinor: row.lineTotalMinor.toString(),
      costStatus: row.costStatus,
      unitCostMinor: hidesUncertainCost ? null : (row.unitCostMinor?.toString() ?? null),
      lineCostMinor: hidesUncertainCost ? null : (row.lineCostMinor?.toString() ?? null),
      inventoryMovementId: row.inventoryMovementId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapTender(row: SaleTenderReadRow): SaleTenderReadResponse {
    return {
      id: row.id,
      moneyAccount: {
        id: row.moneyAccountId,
        name: row.moneyAccountName,
        accountType: row.moneyAccountType,
        status: row.moneyAccountStatus,
      },
      amountMinor: row.amountMinor.toString(),
      paymentAt: row.paymentAt.toISOString(),
      senderAccountName: row.senderAccountName,
      externalReference: row.externalReference,
      moneyMovementId: row.moneyMovementId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapCustomerCreditTender(
    row: SaleCustomerCreditTenderReadRow,
  ): SaleCustomerCreditTenderReadResponse {
    return {
      id: row.id,
      customerId: row.customerId,
      amountMinor: row.amountMinor.toString(),
      customerLedgerEntryId: row.customerLedgerEntryId,
      appliedAt: row.appliedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mapReceivable(row: CustomerReceivableRow): CustomerReceivableResponse {
    const businessDate = this.operationalTime.resolve(row.occurredAt).businessDate;
    return {
      id: row.id,
      customerId: row.customerId,
      accountingPeriodId: row.accountingPeriodId,
      entryType: row.entryType,
      originalAmountMinor: row.originalAmountMinor.toString(),
      outstandingMinor: row.outstandingMinor.toString(),
      sale:
        row.saleId && row.saleDisplayNumber
          ? { id: row.saleId, displayNumber: row.saleDisplayNumber }
          : null,
      occurredAt: row.occurredAt.toISOString(),
      businessDate,
      postingDate: businessDate,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private canonicalUuid(value: string, field: string): string {
    if (!isUUID(value)) {
      throw this.validationException(field, 'isUuid');
    }
    return value.toLowerCase();
  }

  private rethrowQueryError(error: unknown): never {
    if (error instanceof SaleReadQueryError) {
      throw this.validationException(error.field, error.constraint);
    }
    throw error;
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
