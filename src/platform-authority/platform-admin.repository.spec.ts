import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.types';
import { PlatformAdminRepository } from './platform-admin.repository';

describe('Stage 3A Platform Admin response conversion contract', () => {
  const repository = new PlatformAdminRepository();
  const input = {
    action: 'suspend' as const,
    expectedVersion: 1n,
    operationId: randomUUID(),
    requestHash: 'a'.repeat(64),
    reason: 'Transaction contract test',
  };

  it.each([
    { changedAt: 'not a timestamp', storeVersion: '2' },
    { changedAt: new Date(Number.NaN), storeVersion: '2' },
    { changedAt: new Date(), storeVersion: 'not a bigint' },
  ])('rejects invalid conversion inputs inside the repository: %o', async (invalid) => {
    const transaction = {
      execute: jest.fn().mockResolvedValue({ rows: [{ ...invalid }] }),
    } as unknown as DatabaseTransaction;
    await expect(
      repository.mutateStoreLifecycle(transaction, randomUUID(), input),
    ).rejects.toThrow();
  });

  it.each(['2026-11-09T00:00:00.000Z', new Date('2026-11-09T00:00:00.000Z')])(
    'returns validated native values whose response conversion is total: %s',
    async (changedAt) => {
      const transaction = {
        execute: jest.fn().mockResolvedValue({
          rows: [
            {
              changedAt,
              storeVersion: '9223372036854775807',
              storeStatus: 'suspended',
              lifecycleAction: 'suspend',
              storeId: randomUUID(),
              replayed: false,
            },
          ],
        }),
      } as unknown as DatabaseTransaction;
      const result = await repository.mutateStoreLifecycle(transaction, randomUUID(), input);
      expect(result.version.toString()).toBe('9223372036854775807');
      expect(result.changedAt.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    },
  );
});
