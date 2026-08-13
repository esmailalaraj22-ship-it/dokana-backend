import {
  cleanCustomerDisplayName,
  CustomerNormalizationError,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from './customer-normalization';
import type { CustomerSearchScope } from './customer-read.types';

type PhoneNormalizer = (input: string) => string;

export class CustomerReadQueryError extends Error {
  constructor(
    public readonly field: 'search' | 'cursor',
    public readonly constraint: string,
  ) {
    super(`Invalid Customer read ${field}.`);
    this.name = 'CustomerReadQueryError';
  }
}

function isExpectedPhoneValidation(error: CustomerNormalizationError): boolean {
  return (
    error.code === 'CUSTOMER_PHONE_EMPTY' ||
    error.code === 'CUSTOMER_PHONE_INVALID' ||
    error.code === 'CUSTOMER_PHONE_EXTENSION_UNSUPPORTED'
  );
}

export function prepareCustomerSearchScope(
  rawSearch: string | undefined,
  phoneNormalizer: PhoneNormalizer = normalizeCustomerPhone,
): CustomerSearchScope | null {
  if (rawSearch === undefined) {
    return null;
  }

  let displaySearch: string;
  try {
    displaySearch = cleanCustomerDisplayName(rawSearch);
  } catch (error) {
    if (
      error instanceof CustomerNormalizationError &&
      error.code === 'CUSTOMER_DISPLAY_NAME_EMPTY'
    ) {
      return null;
    }
    throw error;
  }

  let canonicalPhone: string | null = null;
  try {
    canonicalPhone = phoneNormalizer(displaySearch);
  } catch (error) {
    if (!(error instanceof CustomerNormalizationError) || !isExpectedPhoneValidation(error)) {
      throw error;
    }
  }

  try {
    return {
      // Canonicalizing recognized phones first keeps equivalent display formats in one scope.
      normalizedNamePrefix: normalizeCustomerName(canonicalPhone ?? displaySearch),
      canonicalPhone,
    };
  } catch (error) {
    if (error instanceof CustomerNormalizationError) {
      throw new CustomerReadQueryError('search', 'customerSearch');
    }
    throw error;
  }
}

export function escapeCustomerNamePrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
