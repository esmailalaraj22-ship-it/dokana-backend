import type { Pool, PoolClient } from 'pg';

import { createRuntimeDatabase } from './database.providers';

describe('runtime transaction primary errors', () => {
  it('preserves BEGIN failure even if discarding the client throws', async () => {
    const primary = new Error('BEGIN failed');
    const query = jest.fn().mockRejectedValue(primary);
    const release = jest.fn(() => {
      throw new Error('release failed');
    });
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const database = createRuntimeDatabase(pool);
    const work = jest.fn();
    await expect(database.transaction(work)).rejects.toMatchObject({ cause: primary });
    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('preserves the work error when rollback and release both fail', async () => {
    const primary = new Error('work failed');
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValue(new Error('rollback failed'));
    const release = jest.fn(() => {
      throw new Error('release failed');
    });
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    await expect(
      createRuntimeDatabase(pool).transaction(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('preserves acquisition failure without invoking work', async () => {
    const primary = new Error('acquisition failed');
    const pool = { connect: jest.fn().mockRejectedValue(primary) } as unknown as Pool;
    const work = jest.fn();
    await expect(createRuntimeDatabase(pool).transaction(work)).rejects.toBe(primary);
    expect(work).not.toHaveBeenCalled();
  });
});
