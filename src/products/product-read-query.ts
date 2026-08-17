import {
  canonicalizeProductBarcode,
  canonicalizeProductName,
  canonicalizeProductSku,
  ProductValidationError,
} from './product-validation';
import { ProductReadQueryError } from './product-read-query-error';
import type { ProductSearchScope } from './product-read.types';

export const PRODUCT_SEARCH_MAX_CODE_UNITS = 512;

export function prepareProductSearchScope(
  rawSearch: string | undefined,
): ProductSearchScope | null {
  if (rawSearch === undefined) {
    return null;
  }
  if (rawSearch.length === 0 || rawSearch.length > PRODUCT_SEARCH_MAX_CODE_UNITS) {
    throw new ProductReadQueryError('search', 'productSearch');
  }

  try {
    const canonicalName = canonicalizeProductName(rawSearch);
    const canonicalSku = canonicalizeProductSku(rawSearch);
    const canonicalBarcode = canonicalizeProductBarcode(rawSearch);
    if (canonicalSku === null || canonicalBarcode === null) {
      throw new ProductReadQueryError('search', 'productSearch');
    }

    return {
      normalizedNamePrefix: canonicalName.normalizedName,
      canonicalSku,
      canonicalBarcode,
    };
  } catch (error) {
    if (error instanceof ProductValidationError) {
      throw new ProductReadQueryError('search', 'productSearch');
    }
    throw error;
  }
}

export function escapeProductNamePrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
