import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type { ChangePullRepository } from './change-pull.repository';
import { ChangePullService } from './change-pull.service';
import type { ChangePullRow } from './change-pull.types';
import {
  InvalidSyncCursorError,
  LegacySyncCursorError,
  type SyncCursorPosition,
  type SyncCursorService,
} from './sync-cursor.service';

describe('ChangePullService', () => {
  const context: TenantTransactionContext = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  const principal: AuthenticatedPrincipal = {
    userId: context.userId,
    email: 'owner@example.invalid',
    fullName: 'Owner',
    storeId: context.storeId,
    storeName: 'Store',
    storeStatus: 'active',
    membershipRole: 'owner',
    membershipVersion: '1',
    deviceId: context.deviceId,
    sessionId: randomUUID(),
    sessionExpiresAt: new Date(Date.now() + 60_000),
  };
  const transaction = {} as DatabaseTransaction;
  let database: {
    withTenantSnapshotTransaction: jest.Mock<
      Promise<unknown>,
      [TenantTransactionContext, (transaction: DatabaseTransaction) => Promise<unknown>]
    >;
  };
  let repository: jest.Mocked<Pick<ChangePullRepository, 'readBounds' | 'readPage'>>;
  let cursors: jest.Mocked<Pick<SyncCursorService, 'decode' | 'issue'>>;
  let service: ChangePullService;

  function row(sequence: bigint, representationVersion = 1): ChangePullRow {
    return {
      storeSequence: sequence,
      eventId: randomUUID(),
      contractVersion: 1,
      representationVersion,
      entityType: 'customer',
      entityKey: randomUUID(),
      entityId: randomUUID(),
      action: 'update',
      entityVersion: 9_223_372_036_854_775_807n,
      operationId: randomUUID(),
      deviceId: context.deviceId,
      representation: { amount_minor: '9007199254740993', version: '9223372036854775807' },
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      capturedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
  }

  beforeEach(() => {
    database = {
      withTenantSnapshotTransaction: jest.fn(async (_context, work) => work(transaction)),
    };
    repository = {
      readBounds: jest.fn().mockResolvedValue({
        streamGeneration: 1,
        headSequence: 12n,
        minimumReplayableSequence: 10n,
      }),
      readPage: jest.fn().mockResolvedValue([row(11n), row(12n)]),
    };
    cursors = {
      decode: jest.fn().mockReturnValue({ storeId: context.storeId, sequence: 10n }),
      issue: jest.fn((_storeId, sequence) => `cursor-${sequence.toString()}`),
    };
    service = new ChangePullService(
      database as unknown as DatabaseService,
      repository,
      cursors as unknown as SyncCursorService,
    );
  });

  it('returns one ordered lossless page and advances only through delivered changes', async () => {
    const response = await service.pull(principal, context, { cursor: 'cursor-10', limit: 2 });

    expect(database.withTenantSnapshotTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(repository.readPage).toHaveBeenCalledWith(transaction, context.storeId, 10n, 2);
    expect(response).toMatchObject({
      changeFeedVersion: 1,
      nextCursor: 'cursor-12',
      hasMore: false,
      changes: [
        {
          sequence: '11',
          representationVersion: 1,
          entityVersion: '9223372036854775807',
          representation: { amount_minor: '9007199254740993' },
        },
        { sequence: '12' },
      ],
    });
  });

  it('redelivers from the same cursor without mutating server cursor state', async () => {
    const first = await service.pull(principal, context, { cursor: 'cursor-10', limit: 2 });
    const retry = await service.pull(principal, context, { cursor: 'cursor-10', limit: 2 });
    expect(retry).toEqual(first);
    expect(repository.readPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new LegacySyncCursorError(), GoneException],
    [new InvalidSyncCursorError(), BadRequestException],
  ])('maps unsafe cursor decoding to a stable response', async (error, expected) => {
    cursors.decode.mockImplementation((): SyncCursorPosition => {
      throw error;
    });
    await expect(service.pull(principal, context, { cursor: 'bad' })).rejects.toBeInstanceOf(
      expected,
    );
    expect(database.withTenantSnapshotTransaction).not.toHaveBeenCalled();
  });

  it('rejects cross-Store, legacy-boundary, and ahead cursors without reading a page', async () => {
    cursors.decode.mockReturnValueOnce({ storeId: randomUUID(), sequence: 10n });
    await expect(
      service.pull(principal, context, { cursor: 'cross-store' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    cursors.decode.mockReturnValueOnce({ storeId: context.storeId, sequence: 9n });
    await expect(service.pull(principal, context, { cursor: 'legacy' })).rejects.toBeInstanceOf(
      GoneException,
    );

    cursors.decode.mockReturnValueOnce({ storeId: context.storeId, sequence: 13n });
    await expect(service.pull(principal, context, { cursor: 'ahead' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.readPage).not.toHaveBeenCalled();
  });

  it('fails closed without cursor advancement for gaps and unknown representation versions', async () => {
    repository.readPage.mockResolvedValueOnce([row(12n)]);
    await expect(service.pull(principal, context, { cursor: 'cursor-10' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(cursors.issue).not.toHaveBeenCalled();

    repository.readPage.mockResolvedValueOnce([row(11n, 2), row(12n)]);
    await expect(service.pull(principal, context, { cursor: 'cursor-10' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(cursors.issue).not.toHaveBeenCalled();
  });

  it('preserves PostgreSQL authorization failures nested by the database adapter', async () => {
    const postgresError = Object.assign(new Error('access denied'), { code: '42501' });
    database.withTenantSnapshotTransaction.mockRejectedValueOnce(
      Object.assign(new Error('query failed'), { cause: postgresError }),
    );

    await expect(service.pull(principal, context, { cursor: 'cursor-10' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(cursors.issue).not.toHaveBeenCalled();
  });
});
