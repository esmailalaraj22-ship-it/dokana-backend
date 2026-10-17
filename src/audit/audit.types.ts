export const auditBusinessActions = [
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_ARCHIVED',
  'CUSTOMER_RESTORED',
  'SUPPLIER_CREATED',
  'SUPPLIER_UPDATED',
  'SUPPLIER_ARCHIVED',
  'SUPPLIER_RESTORED',
  'PRODUCT_CREATED',
  'PRODUCT_UPDATED',
  'PRODUCT_ARCHIVED',
  'PRODUCT_RESTORED',
  'PRODUCT_UNIT_CREATED',
  'PRODUCT_UNIT_UPDATED',
  'PRODUCT_UNIT_ARCHIVED',
  'PRODUCT_UNIT_RESTORED',
  'MONEY_ACCOUNT_CREATED',
  'MONEY_ACCOUNT_UPDATED',
  'MONEY_ACCOUNT_ARCHIVED',
  'MONEY_ACCOUNT_RESTORED',
  'ACCOUNTING_PERIOD_CREATED',
  'ACCOUNTING_PERIOD_UPDATED',
  'ACCOUNTING_PERIOD_CLOSING',
  'ACCOUNTING_PERIOD_CLOSED',
  'ACCOUNTING_PERIOD_REOPENED',
  'SALE_CREATED',
  'SALE_CORRECTED',
  'SALE_CANCELLED',
  'SUPPLIER_INVOICE_CREATED',
  'SUPPLIER_INVOICE_CORRECTED',
  'SUPPLIER_INVOICE_CANCELLED',
  'CUSTOMER_COLLECTION_CREATED',
  'CUSTOMER_COLLECTION_CORRECTED',
  'CUSTOMER_COLLECTION_CANCELLED',
  'SUPPLIER_PAYMENT_CREATED',
  'SUPPLIER_PAYMENT_CORRECTED',
  'SUPPLIER_PAYMENT_CANCELLED',
  'EXPENSE_CREATED',
  'EXPENSE_CORRECTED',
  'EXPENSE_PAYMENT_CREATED',
  'EXPENSE_PAYMENT_CORRECTED',
  'MONEY_TRANSFER_CREATED',
  'MONEY_TRANSFER_CORRECTED',
  'MONEY_TRANSFER_CANCELLED',
  'SALE_RETURN_CREATED',
  'SALE_RETURN_CORRECTED',
  'SALE_RETURN_CANCELLED',
  'SUPPLIER_RETURN_CREATED',
  'SUPPLIER_RETURN_CORRECTED',
  'SUPPLIER_RETURN_CANCELLED',
  'STOCK_COUNT_CREATED',
  'STOCK_COUNT_CORRECTED',
  'STOCK_COUNT_CANCELLED',
  'MANUAL_INVENTORY_CREATED',
  'OWNER_LEDGER_ENTRY_CREATED',
  'OWNER_LEDGER_CORRECTION_CREATED',
  'STORE_SETTINGS_UPDATED',
] as const;

export type AuditBusinessAction = (typeof auditBusinessActions)[number];

export const auditBusinessEntityTypes = [
  'customer',
  'supplier',
  'product',
  'product_unit',
  'money_account',
  'accounting_period',
  'sale',
  'supplier_invoice',
  'customer_collection',
  'supplier_payment',
  'expense',
  'money_transfer',
  'sale_return',
  'supplier_return',
  'stock_count',
  'manual_inventory',
  'owner_ledger',
  'store_settings',
] as const;

export type AuditBusinessEntityType = (typeof auditBusinessEntityTypes)[number];

export type AuditSafeJsonValue =
  string | number | boolean | null | AuditSafeJsonValue[] | { [key: string]: AuditSafeJsonValue };

export type AuditSafeContext = Record<string, AuditSafeJsonValue>;

export interface AuditListAnchor {
  occurredAt: Date;
  eventId: string;
}

export interface AuditListCriteria {
  occurredFrom: Date | null;
  occurredTo: Date | null;
  actorUserId: string | null;
  action: AuditBusinessAction | null;
  entityType: AuditBusinessEntityType | null;
  entityId: string | null;
  limit: number;
  anchor: AuditListAnchor | null;
}

export interface AuditBusinessRow {
  eventId: string;
  action: AuditBusinessAction;
  entityType: AuditBusinessEntityType;
  entityId: string;
  entityReference: string | null;
  actorType: 'user' | 'system';
  actorUserId: string | null;
  actorDisplayName: string | null;
  occurredAt: Date;
  businessDate: string | null;
  context: AuditSafeContext;
}

export interface AuditBusinessItem {
  id: string;
  action: AuditBusinessAction;
  summary: string;
  entity: {
    type: AuditBusinessEntityType;
    id: string;
    reference: string | null;
  };
  actor: {
    type: 'user' | 'system';
    userId: string | null;
    displayName: string | null;
  };
  occurredAt: string;
  businessDate: string | null;
  context: AuditSafeContext;
}

export interface AuditListResponse {
  items: AuditBusinessItem[];
  nextCursor: string | null;
}
