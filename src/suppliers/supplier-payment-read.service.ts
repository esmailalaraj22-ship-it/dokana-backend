import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { ListSupplierPaymentsQueryDto } from './dto/list-supplier-payments-query.dto';
import {
  assertSupplierPaymentCursorScope,
  decodeSupplierPaymentCursor,
  encodeSupplierPaymentCursor,
  supplierPaymentCursorScopeHash,
} from './supplier-payment-read-cursor';
import { SupplierFinancialReadRepository } from './supplier-financial-read.repository';
import type {
  SupplierFinancialSupplierResponse,
  SupplierFinancialSupplierRow,
} from './supplier-financial-read.types';
import type {
  SupplierPaymentAllocationResponse,
  SupplierPaymentAllocationRow,
  SupplierPaymentDetailResponse,
  SupplierPaymentListResponse,
  SupplierPaymentListRow,
  SupplierPaymentSourceResponse,
  SupplierPaymentSummaryResponse,
  SupplierPaymentTargetFilter,
} from './supplier-payment-read.types';
import { SupplierReadQueryError } from './supplier-read-query-error';
import { canonicalizeSupplierUuid } from './supplier-validation';

type SupplierPaymentReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class SupplierPaymentReadService {
  constructor(private readonly repository: SupplierFinancialReadRepository) {}

  async list(
    principal: SupplierPaymentReadPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    query: ListSupplierPaymentsQueryDto,
  ): Promise<SupplierPaymentListResponse> {
    this.assertAuthorized(principal, context);
    try {
      const canonicalSupplierId = canonicalizeSupplierUuid(supplierId, 'id');
      const target = this.resolveTarget(query);
      const limit = query.limit ?? 50;
      const cursor = query.cursor ? decodeSupplierPaymentCursor(query.cursor) : null;
      if (cursor) {
        assertSupplierPaymentCursorScope(cursor, canonicalSupplierId, target);
      }

      const result = await this.repository.readSupplierPaymentPage(context, canonicalSupplierId, {
        anchor: cursor?.anchor ?? null,
        limit,
        target,
      });
      if (!result) throw this.supplierNotFound();

      const hasNextPage = result.payments.length > limit;
      const pageRows = hasNextPage ? result.payments.slice(0, limit) : result.payments;
      const lastRow = pageRows.at(-1);
      return {
        supplier: this.mapSupplier(result.supplier),
        payments: pageRows.map((payment) => this.mapPayment(payment)),
        nextCursor:
          hasNextPage && lastRow
            ? encodeSupplierPaymentCursor({
                scopeHash: supplierPaymentCursorScopeHash(canonicalSupplierId, target),
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

  async getById(
    principal: SupplierPaymentReadPrincipal,
    context: TenantTransactionContext,
    supplierId: string,
    paymentId: string,
  ): Promise<SupplierPaymentDetailResponse> {
    this.assertAuthorized(principal, context);
    const result = await this.repository.findSupplierPayment(
      context,
      canonicalizeSupplierUuid(supplierId, 'id'),
      canonicalizeSupplierUuid(paymentId, 'id'),
    );
    if (!result) {
      throw new NotFoundException({
        code: 'SUPPLIER_PAYMENT_NOT_FOUND',
        message: 'Supplier Payment not found.',
      });
    }
    return {
      supplier: this.mapSupplier(result.supplier),
      payment: this.mapPayment(result),
      allocations: result.allocations.map((allocation) => this.mapAllocation(allocation)),
    };
  }

  private resolveTarget(query: ListSupplierPaymentsQueryDto): SupplierPaymentTargetFilter {
    if (query.invoiceId && query.openingPayableId) {
      throw this.validationException('target', 'supplierPaymentTargetExclusive');
    }
    if (query.invoiceId) {
      return {
        type: 'purchase_invoice',
        id: canonicalizeSupplierUuid(query.invoiceId, 'id'),
      };
    }
    if (query.openingPayableId) {
      return {
        type: 'opening_payable',
        id: canonicalizeSupplierUuid(query.openingPayableId, 'id'),
      };
    }
    return null;
  }

  private assertAuthorized(
    principal: SupplierPaymentReadPrincipal,
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

  private mapPayment(row: SupplierPaymentListRow): SupplierPaymentSummaryResponse {
    return {
      id: row.id,
      operationId: row.operationId,
      supplierId: row.supplierId,
      accountingPeriodId: row.accountingPeriodId,
      amountMinor: row.amountMinor.toString(),
      allocatedTotalMinor: row.allocatedTotalMinor.toString(),
      creditCreatedMinor: row.creditCreatedMinor.toString(),
      occurredAt: row.paymentAt.toISOString(),
      externalReference: row.externalReference,
      notes: row.notes,
      status: row.status,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      source: this.mapSource(row),
      allocationCount: row.allocationCount,
      targetAllocationMinor: row.targetAllocationMinor?.toString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version.toString(),
    };
  }

  private mapSource(row: SupplierPaymentListRow): SupplierPaymentSourceResponse {
    if (row.paymentSource === 'owner_pocket') {
      return { type: 'OWNER', moneyAccount: null };
    }
    if (!row.moneyAccount) {
      throw new Error('Supplier Payment Money Account source is unavailable.');
    }
    return {
      type: 'MONEY_ACCOUNT',
      moneyAccount: {
        id: row.moneyAccount.id,
        name: row.moneyAccount.name,
        accountType: row.moneyAccount.accountType,
        status: row.moneyAccount.status,
      },
    };
  }

  private mapAllocation(row: SupplierPaymentAllocationRow): SupplierPaymentAllocationResponse {
    if (
      row.targetType === 'purchase_invoice' &&
      row.invoiceDisplayNumber !== null &&
      row.invoiceDateAt !== null
    ) {
      return {
        id: row.id,
        target: {
          type: 'SUPPLIER_INVOICE',
          id: row.targetId,
          invoiceNumber: row.invoiceNumber,
          displayNumber: row.invoiceDisplayNumber,
          invoiceDateAt: row.invoiceDateAt.toISOString(),
        },
        amountMinor: row.amountMinor.toString(),
        createdAt: row.createdAt.toISOString(),
      };
    }
    if (
      row.targetType === 'opening_payable' &&
      row.openingAmountMinor !== null &&
      row.openingOccurredAt !== null
    ) {
      return {
        id: row.id,
        target: {
          type: 'OPENING_PAYABLE',
          id: row.targetId,
          amountMinor: row.openingAmountMinor.toString(),
          occurredAt: row.openingOccurredAt.toISOString(),
        },
        amountMinor: row.amountMinor.toString(),
        createdAt: row.createdAt.toISOString(),
      };
    }
    throw new Error('Supplier Payment allocation presentation is inconsistent.');
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
