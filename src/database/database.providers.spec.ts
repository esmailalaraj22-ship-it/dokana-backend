import { Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { createRuntimeDatabase } from './database.providers';

describe('runtime transaction primary errors', () => {
  it('preserves committed success and reports a recoverable release failure', async () => {
    const report = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const release = jest.fn().mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    await expect(createRuntimeDatabase(pool).transaction(async () => 'committed')).resolves.toBe(
      'committed',
    );
    expect(release.mock.calls).toEqual([[], [true]]);
    expect(report).toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves COMMIT failure when rollback fails=%s',
    async (failRollback) => {
      const primary = new Error('COMMIT failed');
      const query = jest.fn(async (config: { text: string }) => {
        if (config.text === 'commit') throw primary;
        if (config.text === 'rollback' && failRollback) throw new Error('ROLLBACK failed');
        return { rows: [] };
      });
      const release = jest.fn();
      const client = { query, release } as unknown as PoolClient;
      const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
      await expect(
        createRuntimeDatabase(pool).transaction(async () => 'result'),
      ).rejects.toMatchObject({ cause: primary });
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
    },
  );

  it.each([false, true])(
    'preserves a savepoint failure when its caller catches=%s',
    async (caught) => {
      const primary = new Error('domain failed');
      const query = jest.fn(async (config: { text: string }) => {
        if (config.text.startsWith('rollback to savepoint'))
          throw new Error('savepoint cleanup failed');
        return { rows: [] };
      });
      const release = jest.fn();
      const client = { query, release } as unknown as PoolClient;
      const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
      await expect(
        createRuntimeDatabase(pool).transaction(async (transaction) => {
          const nested = transaction.transaction(async () => {
            throw primary;
          });
          if (caught) {
            await expect(nested).rejects.toBe(primary);
            return 'must not commit after failed savepoint cleanup';
          }
          return nested;
        }),
      ).rejects.toBe(primary);
      expect(query.mock.calls.map(([config]) => config.text)).not.toContain('commit');
      expect(release).toHaveBeenCalledWith(true);
    },
  );

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
    expect(release).toHaveBeenCalledTimes(2);
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
