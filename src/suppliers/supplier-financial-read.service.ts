import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ListSupplierInvoicesQueryDto } from './dto/list-supplier-invoices-query.dto';
import {
  assertSupplierInvoiceCursorScope,
  decodeSupplierInvoiceCursor,
  encodeSupplierInvoiceCursor,
  supplierInvoiceCursorScopeHash,
} from './supplier-financial-read-cursor';
import { SupplierFinancialReadRepository } from './supplier-financial-read.repository';
import type {
  SupplierFinancialResponse,
  SupplierFinancialSupplierResponse,
  SupplierFinancialSupplierRow,
  SupplierInvoiceDetailResponse,
  SupplierInvoiceItemResponse,
  SupplierInvoiceItemRow,
  SupplierInvoiceListRow,
  SupplierInvoiceSummaryResponse,
} from './supplier-financial-read.types';
import { SupplierReadQueryError } from './supplier-read-query-error';
import { canonicalizeSupplierUuid } from './supplier-validation';

type SupplierFinancialReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierFinancialReadService {
  constructor(private readonly repository: SupplierFinancialReadRepository) {}

  async getSupplierFinancialView(
    principal: SupplierFinancialReadPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    query: ListSupplierInvoicesQueryDto,
  ): Promise<SupplierFinancialResponse> {
    this.assertAuthorized(principal, context);
    try {
      const canonicalSupplierId = canonicalizeSupplierUuid(supplierId, 'id');
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeSupplierInvoiceCursor(query.cursor) : null;
      if (cursor) {
        assertSupplierInvoiceCursorScope(cursor, canonicalSupplierId);
      }

      const result = await this.repository.readSupplierFinancialPage(context, canonicalSupplierId, {
        anchor: cursor?.anchor ?? null,
        limit,
      });
      if (!result) {
        throw this.supplierNotFound();
      }

      const hasNextPage = result.invoices.length > limit;
      const pageRows = hasNextPage ? result.invoices.slice(0, limit) : result.invoices;
      const lastRow = pageRows.at(-1);
      return {
        supplier: this.mapSupplier(result.supplier),
        totalOutstandingMinor: result.totalOutstandingMinor.toString(),
        invoices: pageRows.map((row) => this.mapInvoice(row)),
        nextCursor:
          hasNextPage && lastRow
            ? encodeSupplierInvoiceCursor({
                scopeHash: supplierInvoiceCursorScopeHash(canonicalSupplierId),
                anchor: { id: lastRow.id, version: lastRow.version },
              })
            : null,
      };
    } catch (error) {
      if (error instanceof SupplierReadQueryError) {
        throw this.validationException(error.field, error.constraint);
      }
      throw error;
    }
  }

  async getSupplierInvoice(
    principal: SupplierFinancialReadPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    invoiceId: string,
  ): Promise<SupplierInvoiceDetailResponse> {
    this.assertAuthorized(principal, context);
    const result = await this.repository.findSupplierInvoice(
      context,
      canonicalizeSupplierUuid(supplierId, 'id'),
      canonicalizeSupplierUuid(invoiceId, 'id'),
    );
    if (!result) {
      throw new NotFoundException({
        code: 'SUPPLIER_INVOICE_NOT_FOUND',
        message: 'Supplier Invoice not found.',
      });
    }

    return {
      supplier: this.mapSupplier(result.supplier),
      invoice: {
        ...this.mapInvoice(result),
        notes: result.notes,
        itemsSubtotalMinor: result.itemsSubtotalMinor.toString(),
        lineDiscountTotalMinor: result.lineDiscountTotalMinor.toString(),
        invoiceDiscountMinor: result.invoiceDiscountMinor.toString(),
        roundingMinor: result.roundingMinor.toString(),
        correctionOfId: result.correctionOfId,
        cancelledAt: result.cancelledAt?.toISOString() ?? null,
        createdAt: result.createdAt.toISOString(),
      },
      items: result.items.map((item) => this.mapItem(item)),
    };
  }

  private assertAuthorized(
    principal: SupplierFinancialReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SUPPLIER_READ_NOT_ALLOWED',
        message: 'Supplier reads are not allowed.',
      });
    }
  }

  private mapSupplier(row: SupplierFinancialSupplierRow): SupplierFinancialSupplierResponse {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      version: row.version.toString(),
    };
  }

  private mapInvoice(row: SupplierInvoiceListRow): SupplierInvoiceSummaryResponse {
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      displayNumber: row.displayNumber,
      invoiceDateAt: row.invoiceDateAt.toISOString(),
      postingDate: row.postingDate,
      dueAt: row.dueAt?.toISOString() ?? null,
      status: row.status,
      totalMinor: row.totalMinor.toString(),
      outstandingMinor: row.outstandingMinor.toString(),
      paidAmountMinor: null,
      accountingPeriodId: row.accountingPeriodId,
      correctionOfId: row.correctionOfId,
      replacedById: row.replacedById,
      replacedBySupplierId: row.replacedBySupplierId,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapItem(row: SupplierInvoiceItemRow): SupplierInvoiceItemResponse {
    return {
      id: row.id,
      productId: row.productId,
      productUnitId: row.productUnitId,
      productName: row.productNameSnapshot,
      unitName: row.unitNameSnapshot,
      quantityMilli: row.quantityMilli.toString(),
      conversionFactorNumerator: row.conversionFactorNum,
      conversionFactorDenominator: row.conversionFactorDen,
      baseQuantityMilli: row.baseQuantityMilli.toString(),
      unitCostMinor: row.unitCostMinor.toString(),
      lineGrossMinor: row.lineGrossMinor.toString(),
      lineDiscountMinor: row.lineDiscountMinor.toString(),
      roundingMinor: row.roundingMinor.toString(),
      lineTotalMinor: row.lineTotalMinor.toString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private supplierNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'SUPPLIER_NOT_FOUND',
      message: 'Supplier not found.',
    });
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
