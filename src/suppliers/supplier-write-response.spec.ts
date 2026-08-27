import {
  mapSupplierMutationResponse,
  parseStoredSupplierMutationResponse,
} from './supplier-write-response';
import type { SupplierMutationRow } from './supplier-write.types';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row: SupplierMutationRow = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Supplier',
  normalizedName: 'supplier',
  phone: null,
  normalizedPhone: null,
  notes: 'notes',
  status: 'active',
  archivedAt: null,
  createdAt: new Date('2026-08-27T08:00:00.000Z'),
  updatedAt: new Date('2026-08-27T08:01:00.000Z'),
  version: 9_007_199_254_740_993n,
};

describe('Supplier mutation response', () => {
  it('maps only the approved public projection and serializes version losslessly', () => {
    const response = mapSupplierMutationResponse(row, operationId);
    expect(response).toEqual({
      id: row.id,
      name: row.name,
      phone: null,
      status: 'active',
      archivedAt: null,
      updatedAt: '2026-08-27T08:01:00.000Z',
      notes: 'notes',
      createdAt: '2026-08-27T08:00:00.000Z',
      version: '9007199254740993',
      operationId,
    });
    expect(response).not.toHaveProperty('normalizedName');
    expect(response).not.toHaveProperty('normalizedPhone');
    expect(response).not.toHaveProperty('storeId');
    expect(response).not.toHaveProperty('deviceId');
  });

  it('parses a stored exact-replay snapshot with a legacy null phone', () => {
    const stored = mapSupplierMutationResponse(row, operationId);
    expect(parseStoredSupplierMutationResponse(stored)).toEqual(stored);
  });

  it('rejects malformed stored response snapshots', () => {
    const stored = mapSupplierMutationResponse(row, operationId);
    expect(() => parseStoredSupplierMutationResponse({ ...stored, version: 1 })).toThrow(
      'Stored Supplier mutation response is invalid.',
    );
    expect(() =>
      parseStoredSupplierMutationResponse({ ...stored, operationId: 'invalid' }),
    ).toThrow('Stored Supplier mutation response is invalid.');
  });
});
