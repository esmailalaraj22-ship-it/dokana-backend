import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { SyncAuthenticatedPrincipal } from '../auth/auth.types';
import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type { OfflineLicenseCryptoService } from '../offline-licenses/offline-license-crypto';
import type {
  OfflineLicensePayloadV1,
  SignedOfflineLicense,
} from '../offline-licenses/offline-license.types';
import type { OfflineOperationRegistry } from './offline-operation.registry';
import type { OfflineOperationRepository } from './offline-operation.repository';
import { OfflineOperationService } from './offline-operation.service';

const recoveryGenerationId = '44a15e52-f6d1-41c7-b282-3c5576678dc1';
const context: TenantTransactionContext = {
  storeId: '59e90f52-05aa-4bf4-af84-242686f712a8',
  userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
  deviceId: '873ef648-a779-4aaf-bf8b-936b092ecb93',
  requestId: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  recoveryGenerationId,
};

const principal: SyncAuthenticatedPrincipal = {
  userId: context.userId,
  email: 'owner@example.test',
  fullName: 'Store Owner',
  storeId: context.storeId,
  storeName: 'Test Store',
  storeStatus: 'active',
  membershipRole: 'owner',
  membershipVersion: '1',
  deviceId: context.deviceId,
  sessionId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
  sessionExpiresAt: new Date('2026-01-10T00:00:00.000Z'),
  recoveryGenerationId,
};

const license: OfflineLicensePayloadV1 = {
  licenseVersion: 1,
  licenseId: '71085fe4-f593-4f68-8c0f-d46afc36769b',
  storeId: context.storeId,
  deviceId: context.deviceId,
  subscriptionId: '4da5e8eb-339d-40ce-ab64-acd9813d04d2',
  subscriptionVersion: '1',
  issuedAt: '2026-01-01T00:00:00.000Z',
  offlineValidUntil: '2026-01-08T00:00:00.000Z',
  centralEntitlementEnd: '2026-12-01T00:00:00.000Z',
  storeEntitlement: {
    storeStatus: 'active',
    subscriptionStatus: 'active',
    effectiveAccess: 'write',
  },
  signingKeyId: 'license-v1',
};

const signedLicense: SignedOfflineLicense = {
  algorithm: 'Ed25519',
  payload: license,
  signature: 'x'.repeat(86),
};

function operation(
  localSequence: string,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    operationType: 'customers.create.v1',
    storeId: context.storeId,
    deviceId: context.deviceId,
    recoveryGenerationId: context.recoveryGenerationId,
    aggregateId: randomUUID(),
    clientRecordedAt: '2026-01-02T00:00:00.000Z',
    payload: { name: 'Offline Customer', phone: '0599000000' },
    offlineLicenseId: license.licenseId,
    signedLicense,
    signingKeyId: license.signingKeyId,
    subscriptionId: license.subscriptionId,
    subscriptionVersion: license.subscriptionVersion,
    trustedTimeEvidence: {
      version: 1,
      trustedServerTime: license.issuedAt,
      observedDeviceTime: '2026-01-02T00:00:00.000Z',
      clockState: 'trusted',
      knownStoreStatus: 'active',
      knownStoreStatusAt: license.issuedAt,
    },
    localSequence,
    dependsOnOperationIds: [],
    ...change,
  };
}

describe('OfflineOperationService', () => {
  const transaction = {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
  } as unknown as DatabaseTransaction;
  const database = {
    withTenantTransaction: jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (tx: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    ),
    withOfflineOperationTransaction: jest.fn(
      async (
        _context: TenantTransactionContext,
        _identity: { operationId: string; operationType: string },
        work: (tx: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    ),
    assertSyncRecoveryAuthority: jest.fn().mockResolvedValue({
      recoveryGenerationId: context.recoveryGenerationId,
      authorityNotBefore: null,
    }),
  } as jest.Mocked<
    Pick<
      DatabaseService,
      'withTenantTransaction' | 'withOfflineOperationTransaction' | 'assertSyncRecoveryAuthority'
    >
  >;
  const licenses = {
    verify: jest.fn().mockReturnValue(license),
  } as jest.Mocked<Pick<OfflineLicenseCryptoService, 'verify'>>;
  const repository = {
    begin: jest.fn(),
    finish: jest.fn(),
    readStatus: jest.fn(),
    beginRecovery: jest.fn(),
    finishRecovery: jest.fn(),
  } as jest.Mocked<
    Pick<
      OfflineOperationRepository,
      'begin' | 'finish' | 'readStatus' | 'beginRecovery' | 'finishRecovery'
    >
  >;
  const registry = {
    supports: jest.fn((operationType: string) => operationType === 'customers.create.v1'),
    dispatch: jest.fn(),
  } as unknown as jest.Mocked<Pick<OfflineOperationRegistry, 'supports' | 'dispatch'>>;
  const service = new OfflineOperationService(
    database as unknown as DatabaseService,
    licenses as unknown as OfflineLicenseCryptoService,
    repository,
    registry as unknown as OfflineOperationRegistry,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.execute = jest.fn().mockResolvedValue({ rows: [] });
    licenses.verify.mockReset();
    licenses.verify.mockReturnValue(license);
    registry.supports.mockImplementation(
      (operationType: string) => operationType === 'customers.create.v1',
    );
    registry.dispatch.mockResolvedValue({ id: 'result-id', version: '1' });
    repository.begin.mockResolvedValue({
      disposition: 'authorized',
      reasonCode: null,
      responseBody: null,
      processedOperationPreexisted: false,
    });
    repository.finish.mockResolvedValue({
      disposition: 'applied',
      canonicalRequestHash: 'a'.repeat(64),
      responseBody: { id: 'result-id', version: '1' },
    });
    repository.readStatus.mockResolvedValue({
      operationId: '71085fe4-f593-4f68-8c0f-d46afc36769b',
      status: 'applied',
      reasonCode: null,
      responseBody: { id: 'result-id', version: '1' },
      recoveryEligible: false,
      recoveryAttemptCount: 0,
      lastRecoveryAt: null,
    });
    repository.beginRecovery.mockResolvedValue({
      disposition: 'authorized',
      reasonCode: null,
      responseBody: null,
      processedOperationPreexisted: false,
    });
    repository.finishRecovery.mockResolvedValue({
      disposition: 'applied',
      canonicalRequestHash: 'a'.repeat(64),
      responseBody: { id: 'result-id', version: '1' },
    });
  });

  it('applies one operation through one composed transaction and canonical registry', async () => {
    const input = { operations: [operation('1')] };

    await expect(service.push(input, principal, context)).resolves.toEqual({
      results: [
        {
          operationId: input.operations[0]?.operationId,
          status: 'APPLIED',
          code: null,
          response: { id: 'result-id', version: '1' },
        },
      ],
    });
    expect(database.withOfflineOperationTransaction).toHaveBeenCalledTimes(1);
    expect(repository.begin).toHaveBeenCalledTimes(1);
    expect(registry.dispatch).toHaveBeenCalledTimes(1);
    expect(repository.finish).toHaveBeenCalledWith(
      transaction,
      context.storeId,
      input.operations[0]?.operationId,
      'applied',
      { id: 'result-id', version: '1' },
    );
    expect(transaction.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['exact_replay', 'EXACT_REPLAY'],
    ['dependency_pending', 'DEPENDENCY_PENDING'],
    ['conflict', 'CONFLICT'],
    ['rejected', 'REJECTED'],
    ['quarantined', 'QUARANTINED'],
  ] as const)(
    'returns a stored %s disposition without domain execution',
    async (disposition, status) => {
      repository.begin.mockResolvedValue({
        disposition,
        reasonCode: 'STORED_RESULT',
        responseBody: { stored: true },
        processedOperationPreexisted: true,
      });
      const input = { operations: [operation('1')] };

      await expect(service.push(input, principal, context)).resolves.toEqual({
        results: [
          {
            operationId: input.operations[0]?.operationId,
            status,
            code: 'STORED_RESULT',
            response: { stored: true },
          },
        ],
      });
      expect(registry.dispatch).not.toHaveBeenCalled();
      expect(repository.finish).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed, unknown, context-mismatched, and invalid-License items before execution', async () => {
    const malformed = operation('1', { metadata: {} });
    const unknown = operation('2', { operationType: 'settings.update.v1' });
    const mismatched = operation('3', { storeId: randomUUID() });
    const invalidLicense = operation('4');
    licenses.verify.mockImplementationOnce(() => {
      throw new Error('invalid signature');
    });

    const result = await service.push(
      { operations: [malformed, unknown, mismatched, invalidLicense] },
      principal,
      context,
    );

    expect(result.results.map((entry) => entry.code)).toEqual([
      'SYNC_ENVELOPE_INVALID',
      'SYNC_OPERATION_NOT_ALLOWED',
      'SYNC_CONTEXT_MISMATCH',
      'OFFLINE_LICENSE_INVALID',
    ]);
    expect(database.withOfflineOperationTransaction).not.toHaveBeenCalled();
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [
      new BadRequestException({ code: 'DOMAIN_REJECTED' }),
      'DOMAIN_REJECTED',
      'rejected',
      'REJECTED',
    ],
    [
      new ConflictException({ code: 'OPERATION_ID_CONFLICT' }),
      'OPERATION_ID_CONFLICT',
      'conflict',
      'CONFLICT',
    ],
  ] as const)(
    'rolls back the savepoint and persists a known domain failure',
    async (error, code, disposition, status) => {
      registry.dispatch.mockRejectedValue(error);
      repository.finish.mockResolvedValue({
        disposition,
        canonicalRequestHash: null,
        responseBody: { code },
      });
      const input = { operations: [operation('1')] };

      const result = await service.push(input, principal, context);

      expect(result.results[0]).toMatchObject({ status, code });
      expect(repository.finish).toHaveBeenCalledWith(
        transaction,
        context.storeId,
        input.operations[0]?.operationId,
        disposition,
        expect.objectContaining({ code }),
      );
      expect(transaction.execute).toHaveBeenCalledTimes(3);
    },
  );

  it('orders valid items by local sequence while preserving result positions and item isolation', async () => {
    const third = operation('3');
    const first = operation('1');
    const second = operation('2');
    registry.dispatch.mockImplementation(async (envelope) => {
      if (envelope.localSequence === '2') {
        throw new BadRequestException({ code: 'DOMAIN_REJECTED' });
      }
      return { sequence: envelope.localSequence };
    });
    repository.finish.mockImplementation(
      async (_tx, _storeId, _operationId, disposition, responseBody) => ({
        disposition,
        canonicalRequestHash: disposition === 'applied' ? 'a'.repeat(64) : null,
        responseBody,
      }),
    );

    const result = await service.push({ operations: [third, first, second] }, principal, context);

    expect(registry.dispatch.mock.calls.map(([envelope]) => envelope.localSequence)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual(['APPLIED', 'APPLIED', 'REJECTED']);
    expect(database.withOfflineOperationTransaction).toHaveBeenCalledTimes(3);
  });

  it('reads a sanitized Store-scoped operation status without domain execution', async () => {
    const operationId = '71085fe4-f593-4f68-8c0f-d46afc36769b';

    await expect(service.status(operationId, 'a'.repeat(64), context)).resolves.toEqual({
      operationId,
      status: 'APPLIED',
      code: null,
      response: { id: 'result-id', version: '1' },
      recoveryEligible: false,
      recoveryAttemptCount: 0,
      lastRecoveryAt: null,
    });
    expect(database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(repository.readStatus).toHaveBeenCalledWith(
      transaction,
      context.storeId,
      operationId,
      'a'.repeat(64),
    );
    expect(registry.dispatch).not.toHaveBeenCalled();
  });

  it('recovers the exact original envelope through canonical domain dispatch once', async () => {
    const original = operation('50', {
      trustedTimeEvidence: {
        version: 1,
        trustedServerTime: license.issuedAt,
        observedDeviceTime: '2026-01-02T00:00:00.000Z',
        clockState: 'clock_rollback_suspected',
        knownStoreStatus: 'active',
        knownStoreStatusAt: license.issuedAt,
      },
    });
    const operationId = String(original.operationId);

    await expect(
      service.recover(operationId, { operation: original }, principal, context),
    ).resolves.toEqual({
      operationId,
      status: 'APPLIED',
      code: null,
      response: { id: 'result-id', version: '1' },
    });
    expect(repository.beginRecovery).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ operationId }),
      context.requestId,
    );
    expect(registry.dispatch).toHaveBeenCalledTimes(1);
    expect(repository.finishRecovery).toHaveBeenCalledWith(
      transaction,
      context.storeId,
      operationId,
      context.requestId,
      'applied',
      { id: 'result-id', version: '1' },
    );
  });

  it('returns an already completed recovery attempt as an exact replay', async () => {
    repository.beginRecovery.mockResolvedValue({
      disposition: 'applied',
      reasonCode: null,
      responseBody: { id: 'result-id', version: '1' },
      processedOperationPreexisted: true,
    });
    const original = operation('51');
    const operationId = String(original.operationId);

    await expect(
      service.recover(operationId, { operation: original }, principal, context),
    ).resolves.toEqual({
      operationId,
      status: 'EXACT_REPLAY',
      code: null,
      response: { id: 'result-id', version: '1' },
    });
    expect(registry.dispatch).not.toHaveBeenCalled();
    expect(repository.finishRecovery).not.toHaveBeenCalled();
  });
});
