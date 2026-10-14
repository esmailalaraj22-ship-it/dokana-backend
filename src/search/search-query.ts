import { isUUID } from 'class-validator';

import { CustomerReadQueryError } from '../customers/customer-read-query-error';
import { prepareCustomerSearchScope } from '../customers/customer-read-query';
import {
  MoneyAccountNameValidationError,
  normalizeMoneyAccountNameV1,
} from '../money-accounts/money-account-normalization';
import { ProductReadQueryError } from '../products/product-read-query-error';
import { prepareProductSearchScope } from '../products/product-read-query';
import { SupplierReadQueryError } from '../suppliers/supplier-read-query-error';
import { prepareSupplierSearchScope } from '../suppliers/supplier-read-query';
import type { GlobalSearchScope } from './search.types';

export const GLOBAL_SEARCH_MAX_CODE_UNITS = 256;
const POSTGRESQL_BIGINT_MIN = -9_223_372_036_854_775_808n;
const POSTGRESQL_BIGINT_MAX = 9_223_372_036_854_775_807n;

export class SearchQueryError extends Error {
  constructor(
    public readonly field: 'q' | 'cursor',
    public readonly constraint: string,
  ) {
    super(`Invalid Search query field: ${field}.`);
    this.name = 'SearchQueryError';
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalAmount(value: string): string | null {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const amount = BigInt(value);
  if (amount < POSTGRESQL_BIGINT_MIN || amount > POSTGRESQL_BIGINT_MAX) return null;
  return amount.toString();
}

function canonicalDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    return null;
  return value;
}

export function prepareGlobalSearchScope(rawQuery: string): GlobalSearchScope {
  if (
    rawQuery.length === 0 ||
    rawQuery.length > GLOBAL_SEARCH_MAX_CODE_UNITS ||
    rawQuery.includes('\u0000') ||
    !isWellFormedUnicode(rawQuery)
  ) {
    throw new SearchQueryError('q', 'globalSearch');
  }

  let customer;
  let supplier;
  let product;
  let moneyAccountNamePrefix;
  try {
    customer = prepareCustomerSearchScope(rawQuery);
    supplier = prepareSupplierSearchScope(rawQuery);
    product = prepareProductSearchScope(rawQuery);
    moneyAccountNamePrefix = normalizeMoneyAccountNameV1(rawQuery);
  } catch (error) {
    if (
      error instanceof CustomerReadQueryError ||
      error instanceof SupplierReadQueryError ||
      error instanceof ProductReadQueryError ||
      error instanceof MoneyAccountNameValidationError
    ) {
      throw new SearchQueryError('q', 'globalSearch');
    }
    throw error;
  }
  if (!customer || !supplier || !product) {
    throw new SearchQueryError('q', 'globalSearch');
  }

  const query = product.canonicalSku;
  if (query.length === 0) {
    throw new SearchQueryError('q', 'globalSearch');
  }

  return {
    query,
    customerNamePrefix: customer.normalizedNamePrefix,
    supplierNamePrefix: supplier.normalizedNamePrefix,
    productNamePrefix: product.normalizedNamePrefix,
    moneyAccountNamePrefix,
    canonicalPhone: customer.canonicalPhone ?? supplier.canonicalPhone,
    canonicalSku: product.canonicalSku,
    canonicalBarcode: product.canonicalBarcode,
    text: query.normalize('NFKC').toLowerCase(),
    exactUuid: isUUID(query) ? query.toLowerCase() : null,
    amountMinor: canonicalAmount(query),
    exactDate: canonicalDate(query),
  };
}

export function escapeSearchPrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
