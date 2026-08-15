import { parseStoredCustomerMutationResponse } from './customer-write-response';

const storedResponse = {
  id: '00000000-0000-0000-0000-000000000000',
  name: 'Stored Customer',
  phone: '0599 123 456',
  status: 'active',
  archivedAt: null,
  updatedAt: '2026-08-15T08:01:00.000Z',
  notes: null,
  createdAt: '2026-08-15T08:00:00.000Z',
  version: '1',
  operationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
};

describe('stored Customer mutation response validation', () => {
  it('preserves accepted special Customer and operation UUID values for replay', () => {
    expect(parseStoredCustomerMutationResponse(storedResponse)).toEqual(storedResponse);
  });

  it('accepts historical uppercase semantic UUID text for replay', () => {
    const uppercase = {
      ...storedResponse,
      id: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    };

    expect(parseStoredCustomerMutationResponse(uppercase)).toEqual(uppercase);
  });

  it('rejects stored identifiers outside the Customer contracts', () => {
    expect(() =>
      parseStoredCustomerMutationResponse({ ...storedResponse, id: 'not-a-uuid' }),
    ).toThrow('Stored Customer mutation response is invalid.');
    expect(() =>
      parseStoredCustomerMutationResponse({
        ...storedResponse,
        operationId: '10000000-0000-0000-8000-000000000001',
      }),
    ).toThrow('Stored Customer mutation response is invalid.');
  });
});
