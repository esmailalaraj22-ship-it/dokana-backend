import type { PoolClient, QueryResult } from 'pg';

import { bootstrapFirstPlatformAdmin } from '../../scripts/bootstrap-platform-admin';

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe('first Platform Admin bootstrap', () => {
  const input = {
    userId: '18000000-0000-4000-8000-000000000001',
    operationId: '18000000-0000-4000-8000-000000000002',
    reason: ' Initial controlled bootstrap ',
  };

  it('creates exactly one assignment and immutable audit after strict state checks', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(result([{ pg_advisory_xact_lock: null }]))
      .mockResolvedValueOnce(result([{ targetStatus: 'active', assignmentCount: '0' }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));

    await expect(
      bootstrapFirstPlatformAdmin({ query } as unknown as PoolClient, input),
    ).resolves.toBeUndefined();

    const calls = query.mock.calls as unknown as [string, unknown[]?][];
    expect(query).toHaveBeenCalledTimes(4);
    expect(calls[1]?.[1]).toEqual([input.userId]);
    expect(calls[2]?.[1]).toEqual([input.userId]);
    expect(calls[3]?.[1]).toEqual([
      input.userId,
      'Initial controlled bootstrap',
      input.operationId,
    ]);
  });

  it.each([
    [{ targetStatus: null, assignmentCount: '0' }, 'existing active global user'],
    [{ targetStatus: 'disabled', assignmentCount: '0' }, 'existing active global user'],
    [{ targetStatus: 'active', assignmentCount: '1' }, 'already exists'],
  ])('fails closed for invalid bootstrap state %#', async (state, message) => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(result([{ pg_advisory_xact_lock: null }]))
      .mockResolvedValueOnce(result([state]));

    await expect(
      bootstrapFirstPlatformAdmin({ query } as unknown as PoolClient, input),
    ).rejects.toThrow(message);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
