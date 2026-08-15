import {
  canonicalizeCustomerId,
  canonicalizeCustomerOperationId,
  isCustomerId,
  isCustomerOperationId,
} from './customer-identifiers';

describe('Customer identifier contracts', () => {
  it.each([
    ['version 1', '10000000-0000-1000-8000-000000000001'],
    ['version 4', '10000000-0000-4000-8000-000000000001'],
    ['version 8', '10000000-0000-8000-8000-000000000001'],
    ['nil', '00000000-0000-0000-0000-000000000000'],
    ['maximum', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['uppercase', 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'],
  ])('accepts the existing DTO UUID domain for %s values', (_category, value) => {
    expect(isCustomerId(value)).toBe(true);
    expect(isCustomerOperationId(value)).toBe(true);
  });

  it.each([
    ['malformed', 'not-a-uuid'],
    ['version zero', '10000000-0000-0000-8000-000000000001'],
    ['non-RFC variant', '10000000-0000-4000-7000-000000000001'],
    ['future variant', '10000000-0000-4000-c000-000000000001'],
  ])('rejects values outside the existing DTO UUID domain for %s', (_category, value) => {
    expect(isCustomerId(value)).toBe(false);
    expect(isCustomerOperationId(value)).toBe(false);
    expect(() => canonicalizeCustomerId(value)).toThrow(TypeError);
    expect(() => canonicalizeCustomerOperationId(value)).toThrow(TypeError);
  });

  it('canonicalizes accepted semantic UUID text without changing its value', () => {
    const uppercase = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    const lowercase = uppercase.toLowerCase();

    expect(canonicalizeCustomerId(uppercase)).toBe(lowercase);
    expect(canonicalizeCustomerOperationId(uppercase)).toBe(lowercase);
  });
});
