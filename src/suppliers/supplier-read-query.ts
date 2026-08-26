import { SupplierReadQueryError } from './supplier-read-query-error';
import type { SupplierSearchScope } from './supplier-read.types';
import {
  canonicalizeSupplierName,
  canonicalizeSupplierPhone,
  SupplierValidationError,
  type SupplierValidationErrorCode,
} from './supplier-validation';

export const SUPPLIER_SEARCH_MAX_CODE_UNITS = 512;

const nonPhoneSearchErrors = new Set<SupplierValidationErrorCode>([
  'SUPPLIER_DISPLAY_PHONE_EMPTY',
  'SUPPLIER_PHONE_EMPTY',
  'SUPPLIER_PHONE_INVALID',
  'SUPPLIER_PHONE_EXTENSION_UNSUPPORTED',
]);

export function prepareSupplierSearchScope(
  rawSearch: string | undefined,
): SupplierSearchScope | null {
  if (rawSearch === undefined) {
    return null;
  }
  if (rawSearch.length === 0 || rawSearch.length > SUPPLIER_SEARCH_MAX_CODE_UNITS) {
    throw new SupplierReadQueryError('search', 'supplierSearch');
  }

  try {
    const canonicalName = canonicalizeSupplierName(rawSearch);
    let canonicalPhone: string | null = null;

    try {
      canonicalPhone = canonicalizeSupplierPhone(rawSearch).normalizedPhone;
    } catch (error) {
      if (!(error instanceof SupplierValidationError) || !nonPhoneSearchErrors.has(error.code)) {
        throw error;
      }
    }

    return {
      normalizedNamePrefix: canonicalName.normalizedName,
      canonicalPhone,
    };
  } catch (error) {
    if (error instanceof SupplierValidationError) {
      throw new SupplierReadQueryError('search', 'supplierSearch');
    }
    throw error;
  }
}

export function escapeSupplierNamePrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
