import {
  canonicalizeCommandOperationId,
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
  MoneyFactIdentityError,
  S10_FACT_NAMESPACE,
} from './money-movement-identity';

describe('deterministic money fact identity', () => {
  const command = '7f3a9c2e-1b4d-4a6f-8c0e-2d5b7e9a1c33';

  it('pins the frozen namespace and approved test vectors', () => {
    expect(S10_FACT_NAMESPACE).toBe('faafc598-0d3d-5010-a246-0c178972e337');

    expect(deriveMoneyFactId(command, 'opening')).toBe('29d91ec3-f470-5698-af7b-0be86931a7ad');
    expect(deriveMoneyFactOperationId(command, 'opening')).toBe(
      '93c3fabf-9cba-5439-9520-b85d36402106',
    );
    expect(deriveMoneyFactId(command, 'owner-money')).toBe('4fb42be9-9167-536a-b32b-c52bb1f6673d');
    expect(deriveMoneyFactOperationId(command, 'owner-money')).toBe(
      'e19a7e2f-e956-5e06-9a3f-6554371ac1cb',
    );
    expect(deriveMoneyFactId(command, 'owner-entry')).toBe('cf6bec35-21d0-5d5f-84f8-5b93712b683e');
    expect(deriveMoneyFactOperationId(command, 'owner-entry')).toBe(
      'd6f8f595-2938-57ba-acbd-9ecc0079d204',
    );
    expect(deriveMoneyFactId(command, 'transfer-source')).toBe(
      '8afc9b08-3b8e-5240-b560-69821294a154',
    );
    expect(deriveMoneyFactOperationId(command, 'transfer-source')).toBe(
      '4241cec8-4e2d-5010-8eb6-37ca37d8c9d3',
    );
    expect(deriveMoneyFactId(command, 'transfer-destination')).toBe(
      '45685b8c-4f79-5a4f-b5be-1d0e4c16aea8',
    );
    expect(deriveMoneyFactOperationId(command, 'transfer-destination')).toBe(
      '26a66f60-c2b7-5bdc-83a9-094f59d15466',
    );
    expect(deriveMoneyFactId(command, 'transfer-header')).toBe(
      '4bff13e7-f520-5287-b0aa-3581510bbc5f',
    );
    expect(deriveMoneyFactOperationId(command, 'transfer-header')).toBe(
      '07cde60a-d459-5a96-94f2-8762d78f4106',
    );
  });

  it('is stable and case-insensitive on the command id', () => {
    expect(deriveMoneyFactId(command.toUpperCase(), 'opening')).toBe(
      deriveMoneyFactId(command, 'opening'),
    );
    expect(deriveTransactionGroupId(command.toUpperCase())).toBe(command);
  });

  it('changes with the effect discriminator and with the command', () => {
    expect(deriveMoneyFactId(command, 'transfer-source')).not.toBe(
      deriveMoneyFactId(command, 'transfer-destination'),
    );
    expect(deriveMoneyFactId(command, 'opening')).not.toBe(
      deriveMoneyFactOperationId(command, 'opening'),
    );
    expect(deriveMoneyFactId('00000000-0000-4000-8000-000000000001', 'opening')).not.toBe(
      deriveMoneyFactId(command, 'opening'),
    );
  });

  it('rejects a malformed command id', () => {
    expect(() => canonicalizeCommandOperationId('not-a-uuid')).toThrow(MoneyFactIdentityError);
    expect(() => deriveMoneyFactId('not-a-uuid', 'opening')).toThrow(MoneyFactIdentityError);
  });
});
