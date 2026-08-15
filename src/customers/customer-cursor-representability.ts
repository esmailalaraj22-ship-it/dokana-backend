import { encodeCustomerCursor } from './customer-read-cursor';
import type { CustomerSearchScope } from './customer-read.types';

// The worst non-budgeted payload, including a 16-character canonical phone,
// is 138 bytes. The remaining 1,398 bytes are split equally between the two
// independent JSON strings. Encoder-bound tests detect envelope drift.
export const CUSTOMER_CURSOR_NORMALIZED_NAME_JSON_BYTE_BUDGET = 699;
export const CUSTOMER_CURSOR_SEARCH_NAME_JSON_BYTE_BUDGET = 699;

const maximumCustomerId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maximumCanonicalPhone = '+123456789012345';
const maximumNormalizedName = 'n'.repeat(CUSTOMER_CURSOR_NORMALIZED_NAME_JSON_BYTE_BUDGET);
const maximumSearchName = 's'.repeat(CUSTOMER_CURSOR_SEARCH_NAME_JSON_BYTE_BUDGET);

export class CustomerCursorRepresentabilityError extends Error {
  constructor(public readonly field: 'name' | 'search') {
    super(`Customer ${field} cannot be represented in the current cursor envelope.`);
    this.name = 'CustomerCursorRepresentabilityError';
  }
}

export function customerCursorJsonStringContentByteLength(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
}

function assertJsonStringBudget(value: string, budget: number, field: 'name' | 'search'): void {
  if (customerCursorJsonStringContentByteLength(value) > budget) {
    throw new CustomerCursorRepresentabilityError(field);
  }
}

function assertProductionCursorFits(
  field: 'name' | 'search',
  input: Parameters<typeof encodeCustomerCursor>[0],
): void {
  try {
    encodeCustomerCursor(input);
  } catch {
    throw new CustomerCursorRepresentabilityError(field);
  }
}

export function assertCustomerNormalizedNameCursorRepresentable(normalizedName: string): void {
  assertJsonStringBudget(normalizedName, CUSTOMER_CURSOR_NORMALIZED_NAME_JSON_BYTE_BUDGET, 'name');
  assertProductionCursorFits('name', {
    status: 'archived',
    search: {
      normalizedNamePrefix: maximumSearchName,
      canonicalPhone: maximumCanonicalPhone,
    },
    position: { normalizedName, id: maximumCustomerId },
  });
}

export function assertCustomerSearchCursorRepresentable(search: CustomerSearchScope): void {
  assertJsonStringBudget(
    search.normalizedNamePrefix,
    CUSTOMER_CURSOR_SEARCH_NAME_JSON_BYTE_BUDGET,
    'search',
  );
  assertProductionCursorFits('search', {
    status: 'archived',
    search,
    position: { normalizedName: maximumNormalizedName, id: maximumCustomerId },
  });
}
