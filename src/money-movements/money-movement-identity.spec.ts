import {
  canonicalizeCommandOperationId,
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
  MoneyFactIdentityError,
  S10_FACT_NAMESPACE,
} from './money-movement-identity';

describe('deterministic money fact identity', () => {
  const storeId = '10000000-0000-4000-8000-000000000001';
  const command = '7f3a9c2e-1b4d-4a6f-8c0e-2d5b7e9a1c33';

  it('pins the frozen namespace and approved test vectors', () => {
    expect(S10_FACT_NAMESPACE).toBe('faafc598-0d3d-5010-a246-0c178972e337');

    expect(deriveMoneyFactId(storeId, command, 'opening')).toBe(
      'd79ad69a-59ee-554a-94a1-9a85fb28c365',
    );
    expect(deriveMoneyFactOperationId(storeId, command, 'opening')).toBe(
      'c90a83e9-ab85-542d-9164-e0c6f22d1de0',
    );
    expect(deriveMoneyFactId(storeId, command, 'owner-money')).toBe(
      '1760fb70-7beb-531a-b9fc-6339c4f1e3ce',
    );
    expect(deriveMoneyFactOperationId(storeId, command, 'owner-money')).toBe(
      '22aca6f1-b2d0-57b6-bc60-5b5bd12954da',
    );
    expect(deriveMoneyFactId(storeId, command, 'owner-entry')).toBe(
      '6a2373f1-bb6a-5ee5-b393-4ec9c15e2178',
    );
    expect(deriveMoneyFactOperationId(storeId, command, 'owner-entry')).toBe(
      'aa586aed-a607-5192-95db-e2b168a2c1c8',
    );
    expect(deriveMoneyFactId(storeId, command, 'transfer-source')).toBe(
      '92db34a1-c74b-5f98-bc4f-db7c9110cea1',
    );
    expect(deriveMoneyFactOperationId(storeId, command, 'transfer-source')).toBe(
      '4bf222e6-8a0e-577e-929a-d3813d7b30e1',
    );
    expect(deriveMoneyFactId(storeId, command, 'transfer-destination')).toBe(
      '004d2fc2-06da-5aac-a688-56d4c850717b',
    );
    expect(deriveMoneyFactOperationId(storeId, command, 'transfer-destination')).toBe(
      '5f08609c-2749-5a0d-b8bd-4e7aa4340c18',
    );
    expect(deriveMoneyFactId(storeId, command, 'transfer-header')).toBe(
      'ed64cda6-c5b0-5868-af4b-073f6e000cbb',
    );
    expect(deriveMoneyFactOperationId(storeId, command, 'transfer-header')).toBe(
      '8474e615-b4e1-5702-b755-a724a9ba21aa',
    );
  });

  it('is stable and case-insensitive on the Store and command IDs', () => {
    expect(deriveMoneyFactId(storeId.toUpperCase(), command.toUpperCase(), 'opening')).toBe(
      deriveMoneyFactId(storeId, command, 'opening'),
    );
    expect(deriveTransactionGroupId(command.toUpperCase())).toBe(command);
  });

  it('derives correction facts from base semantic roles without recursive prefixes', () => {
    const reversal = deriveMoneyFactId(storeId, command, 'reversal:owner-money');
    const replacement = deriveMoneyFactId(storeId, command, 'replacement:owner-money');

    expect(reversal).toBe('00939954-83d8-5501-b48f-936e465bf50f');
    expect(replacement).toBe('64c19620-7bb4-5745-baaa-be9c47f551a3');
    expect(reversal).not.toBe(replacement);
    expect(deriveMoneyFactId(storeId, command, 'replacement:transfer-header')).toBe(
      'e4958461-15c4-524f-bef5-23ec2684756c',
    );
  });

  it('changes with the effect discriminator and with the command', () => {
    expect(deriveMoneyFactId(storeId, command, 'transfer-source')).not.toBe(
      deriveMoneyFactId(storeId, command, 'transfer-destination'),
    );
    expect(deriveMoneyFactId(storeId, command, 'opening')).not.toBe(
      deriveMoneyFactOperationId(storeId, command, 'opening'),
    );
    expect(deriveMoneyFactId(storeId, '00000000-0000-4000-8000-000000000001', 'opening')).not.toBe(
      deriveMoneyFactId(storeId, command, 'opening'),
    );
  });

  it('rejects a malformed command id', () => {
    expect(() => canonicalizeCommandOperationId('not-a-uuid')).toThrow(MoneyFactIdentityError);
    expect(() => deriveMoneyFactId(storeId, 'not-a-uuid', 'opening')).toThrow(
      MoneyFactIdentityError,
    );
  });

  it('separates both fact and fact-operation identities across Stores', () => {
    const otherStore = '20000000-0000-4000-8000-000000000001';
    for (const derive of [deriveMoneyFactId, deriveMoneyFactOperationId]) {
      expect(derive(storeId, command, 'transfer-source')).not.toBe(
        derive(otherStore, command, 'transfer-source'),
      );
      expect(() => derive('not-a-store', command, 'opening')).toThrow(MoneyFactIdentityError);
      expect(() => derive('', command, 'opening')).toThrow(MoneyFactIdentityError);
    }
  });
});
