import type { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';

import type { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from './database.service';
import type {
  DatabaseClient,
  DatabaseTransaction,
  TenantTransactionContext,
} from './database.types';

describe('DatabaseService tenant transactions', () => {
  const context: TenantTransactionContext = {
    storeId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
    userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
    deviceId: '59e90f52-05aa-4bf4-af84-242686f712a8',
    requestId: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  };

  const execute = jest.fn().mockResolvedValue(undefined);
  const transaction = {
    execute,
  } as unknown as DatabaseTransaction;
  const database = {
    transaction: jest.fn(async (work: (value: DatabaseTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  } as unknown as DatabaseClient;
  const pool = {
    on: jest.fn(),
  } as unknown as Pool;
  const config = {} as AppConfigService;
  const logger = {
    error: jest.fn(),
  } as unknown as PinoLogger;
  const service = new DatabaseService(database, pool, config, logger);

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue(undefined);
  });

  it('sets every required transaction-local tenant value before work runs', async () => {
    const work = jest.fn().mockResolvedValue('completed');

    await expect(service.withTenantTransaction(context, work)).resolves.toBe('completed');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(work).toHaveBeenCalledWith(transaction);
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed context before opening a transaction', async () => {
    await expect(
      service.withTenantTransaction(
        {
          ...context,
          storeId: 'not-a-uuid',
        },
        jest.fn(),
      ),
    ).rejects.toThrow('must be UUIDs');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
