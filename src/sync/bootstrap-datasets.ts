import type { BootstrapDatasetDefinition } from './bootstrap.types';

export const bootstrapPageSize = 100;
export const bootstrapVersion = 1 as const;
export const syncProtocolVersion = 1 as const;
export const syncChangeFeedVersion = 1 as const;
export const sqliteSchemaVersion = 10_300 as const;

// The order follows local dependency roots before immutable transactions and their effects.
// Every relation and ordering expression is a closed server-side allow-list.
export const bootstrapBusinessDatasets: readonly BootstrapDatasetDefinition[] = [
  { id: 'stores', relation: 'ledger.stores', scope: 'store-root', orderBy: 'source.id' },
  {
    id: 'devices',
    relation: 'ledger.devices',
    scope: 'current-device',
    orderBy: 'source.id',
  },
  {
    id: 'app_settings',
    relation: 'ledger.app_settings',
    scope: 'store',
    orderBy: 'source.store_id',
    omittedFields: ['attachments_directory_uri', 'export_directory_uri'],
  },
  {
    id: 'document_sequences',
    relation: 'ledger.document_sequences',
    scope: 'store',
    orderBy: 'source.device_id, source.document_type, source.sequence_year',
  },
  { id: 'customers', relation: 'ledger.customers', scope: 'store', orderBy: 'source.id' },
  { id: 'suppliers', relation: 'ledger.suppliers', scope: 'store', orderBy: 'source.id' },
  { id: 'products', relation: 'ledger.products', scope: 'store', orderBy: 'source.id' },
  {
    id: 'product_units',
    relation: 'ledger.product_units',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'money_accounts',
    relation: 'ledger.money_accounts',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'accounting_periods',
    relation: 'ledger.accounting_periods',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'expense_categories',
    relation: 'ledger.expense_categories',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'purchase_invoices',
    relation: 'ledger.purchase_invoices',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'purchase_items',
    relation: 'ledger.purchase_items',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'goods_receipts',
    relation: 'ledger.goods_receipts',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'goods_receipt_items',
    relation: 'ledger.goods_receipt_items',
    scope: 'store',
    orderBy: 'source.id',
  },
  { id: 'sales', relation: 'ledger.sales', scope: 'store', orderBy: 'source.id' },
  {
    id: 'sale_items',
    relation: 'ledger.sale_items',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'customer_payments',
    relation: 'ledger.customer_payments',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'supplier_payments',
    relation: 'ledger.supplier_payments',
    scope: 'store',
    orderBy: 'source.id',
  },
  { id: 'expenses', relation: 'ledger.expenses', scope: 'store', orderBy: 'source.id' },
  {
    id: 'money_transfers',
    relation: 'ledger.money_transfers',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'sale_returns',
    relation: 'ledger.sale_returns',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'sale_return_items',
    relation: 'ledger.sale_return_items',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'supplier_returns',
    relation: 'ledger.supplier_returns',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'supplier_return_items',
    relation: 'ledger.supplier_return_items',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'manual_inventory_entries',
    relation: 'ledger.manual_inventory_entries',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'stock_counts',
    relation: 'ledger.stock_counts',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'stock_count_items',
    relation: 'ledger.stock_count_items',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'inventory_movements',
    relation: 'ledger.inventory_movements',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'stock_balances',
    relation: 'ledger.stock_balances',
    scope: 'store',
    orderBy: 'source.product_id',
  },
  {
    id: 'money_movements',
    relation: 'ledger.money_movements',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'sale_payments',
    relation: 'ledger.sale_payments',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'customer_payment_allocations',
    relation: 'ledger.customer_payment_allocations',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'sale_customer_credit_applications',
    relation: 'ledger.sale_customer_credit_applications',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'supplier_payment_allocations',
    relation: 'ledger.supplier_payment_allocations',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'expense_payments',
    relation: 'ledger.expense_payments',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'sale_return_settlements',
    relation: 'ledger.sale_return_settlements',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'supplier_return_settlements',
    relation: 'ledger.supplier_return_settlements',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'customer_ledger_entries',
    relation: 'ledger.customer_ledger_entries',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'supplier_ledger_entries',
    relation: 'ledger.supplier_ledger_entries',
    scope: 'store',
    orderBy: 'source.id',
  },
  {
    id: 'owner_ledger_entries',
    relation: 'ledger.owner_ledger_entries',
    scope: 'store',
    orderBy: 'source.id',
  },
];

export const bootstrapSyntheticDatasetIds = [
  'local_users',
  'offline_license_verification_keys',
  'local_license',
  'offline_trusted_time_state',
] as const;
