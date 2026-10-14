export const SEARCH_RESULT_TYPES = [
  'customer',
  'supplier',
  'product',
  'sale',
  'supplier_invoice',
  'expense',
  'customer_collection',
  'supplier_payment',
  'money_account',
  'money_movement',
  'sale_return',
  'supplier_return',
  'inventory_movement',
] as const;

export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export interface GlobalSearchScope {
  query: string;
  customerNamePrefix: string;
  supplierNamePrefix: string;
  productNamePrefix: string;
  moneyAccountNamePrefix: string;
  canonicalPhone: string | null;
  canonicalSku: string;
  canonicalBarcode: string;
  text: string;
  exactUuid: string | null;
  amountMinor: string | null;
  exactDate: string | null;
}

export interface SearchCursorAnchor {
  matchRank: number;
  sortAt: string;
  type: SearchResultType;
  id: string;
}

export interface SearchRepositoryCriteria {
  scope: GlobalSearchScope;
  resultType: SearchResultType | null;
  anchor: SearchCursorAnchor | null;
  limit: number;
}

export interface SearchRepositoryRow extends Record<string, unknown> {
  type: SearchResultType;
  id: string;
  primaryLabel: string;
  secondaryLabel: string | null;
  status: string | null;
  displayNumber: string | null;
  amountMinor: string | null;
  quantityMilli: string | null;
  businessDate: string | null;
  occurredAt: Date | string | null;
  matchRank: number;
  sortAt: Date | string;
}

export interface SearchResult {
  type: SearchResultType;
  id: string;
  primaryLabel: string;
  secondaryLabel: string | null;
  status: string | null;
  displayNumber: string | null;
  amountMinor: string | null;
  quantityMilli: string | null;
  businessDate: string | null;
  occurredAt: string | null;
}

export interface GlobalSearchResponse {
  filters: {
    q: string;
    type: SearchResultType | null;
  };
  items: SearchResult[];
  pagination: {
    limit: number;
    nextCursor: string | null;
  };
}
