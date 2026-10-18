import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { auditCursorScopeHash, decodeAuditCursor, encodeAuditCursor } from './audit-cursor';
import { AuditRepository } from './audit.repository';
import type { ListAuditQueryDto } from './dto/list-audit-query.dto';
import type {
  AuditBusinessAction,
  AuditBusinessItem,
  AuditListCriteria,
  AuditListResponse,
} from './audit.types';

type AuditPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

const summaries: Readonly<Record<AuditBusinessAction, string>> = {
  CUSTOMER_CREATED: 'Customer created',
  CUSTOMER_UPDATED: 'Customer updated',
  CUSTOMER_ARCHIVED: 'Customer archived',
  CUSTOMER_RESTORED: 'Customer restored',
  SUPPLIER_CREATED: 'Supplier created',
  SUPPLIER_UPDATED: 'Supplier updated',
  SUPPLIER_ARCHIVED: 'Supplier archived',
  SUPPLIER_RESTORED: 'Supplier restored',
  PRODUCT_CREATED: 'Product created',
  PRODUCT_UPDATED: 'Product updated',
  PRODUCT_ARCHIVED: 'Product archived',
  PRODUCT_RESTORED: 'Product restored',
  PRODUCT_UNIT_CREATED: 'Product unit created',
  PRODUCT_UNIT_UPDATED: 'Product unit updated',
  PRODUCT_UNIT_ARCHIVED: 'Product unit archived',
  PRODUCT_UNIT_RESTORED: 'Product unit restored',
  MONEY_ACCOUNT_CREATED: 'Money account created',
  MONEY_ACCOUNT_UPDATED: 'Money account updated',
  MONEY_ACCOUNT_ARCHIVED: 'Money account archived',
  MONEY_ACCOUNT_RESTORED: 'Money account restored',
  ACCOUNTING_PERIOD_CREATED: 'Accounting period created',
  ACCOUNTING_PERIOD_UPDATED: 'Accounting period updated',
  ACCOUNTING_PERIOD_CLOSING: 'Accounting period closing started',
  ACCOUNTING_PERIOD_CLOSED: 'Accounting period closed',
  ACCOUNTING_PERIOD_REOPENED: 'Accounting period reopened',
  SALE_CREATED: 'Sale posted',
  SALE_CORRECTED: 'Sale corrected',
  SALE_CANCELLED: 'Sale cancelled',
  SUPPLIER_INVOICE_CREATED: 'Supplier invoice posted',
  SUPPLIER_INVOICE_CORRECTED: 'Supplier invoice corrected',
  SUPPLIER_INVOICE_CANCELLED: 'Supplier invoice cancelled',
  CUSTOMER_COLLECTION_CREATED: 'Customer collection posted',
  CUSTOMER_COLLECTION_CORRECTED: 'Customer collection corrected',
  CUSTOMER_COLLECTION_CANCELLED: 'Customer collection cancelled',
  SUPPLIER_PAYMENT_CREATED: 'Supplier payment posted',
  SUPPLIER_PAYMENT_CORRECTED: 'Supplier payment corrected',
  SUPPLIER_PAYMENT_CANCELLED: 'Supplier payment cancelled',
  EXPENSE_CREATED: 'Expense posted',
  EXPENSE_CORRECTED: 'Expense corrected',
  EXPENSE_PAYMENT_CREATED: 'Expense payment posted',
  EXPENSE_PAYMENT_CORRECTED: 'Expense payment corrected',
  MONEY_TRANSFER_CREATED: 'Money transfer posted',
  MONEY_TRANSFER_CORRECTED: 'Money transfer corrected',
  MONEY_TRANSFER_CANCELLED: 'Money transfer cancelled',
  SALE_RETURN_CREATED: 'Sale return posted',
  SALE_RETURN_CORRECTED: 'Sale return corrected',
  SALE_RETURN_CANCELLED: 'Sale return cancelled',
  SUPPLIER_RETURN_CREATED: 'Supplier return posted',
  SUPPLIER_RETURN_CORRECTED: 'Supplier return corrected',
  SUPPLIER_RETURN_CANCELLED: 'Supplier return cancelled',
  STOCK_COUNT_CREATED: 'Stock count posted',
  STOCK_COUNT_CORRECTED: 'Stock count corrected',
  STOCK_COUNT_CANCELLED: 'Stock count cancelled',
  MANUAL_INVENTORY_CREATED: 'Manual inventory entry posted',
  OWNER_LEDGER_ENTRY_CREATED: 'Owner Ledger entry posted',
  OWNER_LEDGER_CORRECTION_CREATED: 'Owner Ledger correction posted',
  STORE_SETTINGS_UPDATED: 'Store operational settings updated',
  ATTACHMENT_ADDED: 'Attachment added',
  ATTACHMENT_REMOVED: 'Attachment removed',
};

@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async list(
    principal: AuditPrincipal,
    context: TenantTransactionContext,
    query: ListAuditQueryDto,
  ): Promise<AuditListResponse> {
    this.assertAuthorized(principal, context);
    const occurredFrom = query.occurredFrom ? new Date(query.occurredFrom) : null;
    const occurredTo = query.occurredTo ? new Date(query.occurredTo) : null;
    if (occurredFrom && occurredTo && occurredFrom > occurredTo) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: [{ field: 'occurredFrom', constraints: ['auditDateRange'] }],
      });
    }

    const scope = {
      storeId: context.storeId,
      occurredFrom,
      occurredTo,
      actorUserId: query.actorUserId?.toLowerCase() ?? null,
      action: query.action ?? null,
      entityType: query.entityType ?? null,
      entityId: query.entityId?.toLowerCase() ?? null,
    };
    const scopeHash = auditCursorScopeHash(scope);
    const limit = query.limit ?? 50;
    const criteria: AuditListCriteria = {
      occurredFrom,
      occurredTo,
      actorUserId: scope.actorUserId,
      action: scope.action,
      entityType: scope.entityType,
      entityId: scope.entityId,
      limit,
      anchor: query.cursor ? decodeAuditCursor(query.cursor, scopeHash) : null,
    };
    const rows = await this.repository.list(context, criteria);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.mapItem(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeAuditCursor({ occurredAt: last.occurredAt, eventId: last.eventId }, scopeHash)
          : null,
    };
  }

  private assertAuthorized(principal: AuditPrincipal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'AUDIT_ACCESS_NOT_ALLOWED',
        message: 'Business audit access is not allowed.',
      });
    }
  }

  private mapItem(row: Awaited<ReturnType<AuditRepository['list']>>[number]): AuditBusinessItem {
    return {
      id: row.eventId,
      action: row.action,
      summary: summaries[row.action],
      entity: {
        type: row.entityType,
        id: row.entityId,
        reference: row.entityReference,
      },
      actor: {
        type: row.actorType,
        userId: row.actorUserId,
        displayName: row.actorDisplayName,
      },
      occurredAt: row.occurredAt.toISOString(),
      businessDate: row.businessDate,
      context: row.context,
    };
  }
}
