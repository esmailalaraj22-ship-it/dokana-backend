import { generateKeyPairSync, randomUUID } from 'node:crypto';

import type { AppConfigService } from '../config/app-config.service';
import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { OfflineLicenseCryptoService } from './offline-license-crypto';
import type { OfflineLicenseRepository } from './offline-license.repository';
import { OfflineLicenseService } from './offline-license.service';
import type { OfflineLicensePayloadV1 } from './offline-license.types';

const transaction = {} as DatabaseTransaction;

function cryptoFixture(keyId = 'service-v1') {
  const keys = generateKeyPairSync('ed25519');
  return new OfflineLicenseCryptoService({
    offlineLicenseSigning: {
      activeKeyId: keyId,
      activePrivateKeyPkcs8: keys.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64url'),
      publicKeys: {
        [keyId]: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
    },
  } as unknown as AppConfigService);
}

describe('OfflineLicenseService', () => {
  const context: TenantTransactionContext = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  const principal = {
    ...context,
    email: 'owner@example.test',
    fullName: 'Owner',
    storeName: 'Store',
    storeStatus: 'active' as const,
    membershipRole: 'owner' as const,
    membershipVersion: '1',
    sessionId: randomUUID(),
    sessionExpiresAt: new Date('2026-11-01T00:00:00Z'),
  };
  let database: DatabaseService;
  let repository: jest.Mocked<Pick<OfflineLicenseRepository, 'prepare' | 'complete'>>;
  let crypto: OfflineLicenseCryptoService;
  let service: OfflineLicenseService;

  beforeEach(() => {
    crypto = cryptoFixture();
    database = {
      withTenantTransaction: jest.fn(
        async (
          _context: TenantTransactionContext,
          work: (value: DatabaseTransaction) => Promise<unknown>,
        ) => work(transaction),
      ),
    } as unknown as DatabaseService;
    repository = {
      prepare: jest.fn(),
      complete: jest.fn(),
    };
    service = new OfflineLicenseService(
      database,
      repository as unknown as OfflineLicenseRepository,
      crypto,
    );
  });

  function payload(licenseId: string): OfflineLicensePayloadV1 {
    return {
      licenseVersion: 1,
      licenseId,
      storeId: context.storeId,
      deviceId: context.deviceId,
      subscriptionId: randomUUID(),
      subscriptionVersion: '1',
      issuedAt: '2026-10-04T00:00:00.000000Z',
      offlineValidUntil: '2026-10-11T00:00:00.000000Z',
      centralEntitlementEnd: '2026-11-01T00:00:00.000000Z',
      storeEntitlement: {
        storeStatus: 'active',
        subscriptionStatus: 'active',
        effectiveAccess: 'write',
      },
      signingKeyId: crypto.activeSigningKeyId,
    };
  }

  it('signs a prepared database payload and completes it in the same transaction', async () => {
    const licenseId = randomUUID();
    const licensePayload = payload(licenseId);
    repository.prepare.mockResolvedValue({
      licenseId,
      signedPayload: licensePayload,
      signature: '',
      keyId: crypto.activeSigningKeyId,
      issuedAt: new Date(licensePayload.issuedAt),
      expiresAt: new Date(licensePayload.offlineValidUntil),
      replayed: false,
      requiresSignature: true,
    });
    repository.complete.mockImplementation(async (_transaction, _context, _input, signature) => ({
      licenseId,
      signedPayload: licensePayload,
      signature,
      keyId: crypto.activeSigningKeyId,
      issuedAt: new Date(licensePayload.issuedAt),
      expiresAt: new Date(licensePayload.offlineValidUntil),
      replayed: false,
    }));

    const response = await service.issue(principal, context, { operationId: randomUUID() });

    expect(crypto.verify(response.license)).toEqual(licensePayload);
    expect(response.trustedTime).toMatchObject({
      expiryBoundary: 'exclusive',
      clockRollbackPolicy: 'read_only_and_online_revalidation_required',
    });
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });

  it('returns an exact persisted replay without signing a replacement License', async () => {
    const licenseId = randomUUID();
    const licensePayload = payload(licenseId);
    const document = crypto.sign(licensePayload);
    repository.prepare.mockResolvedValue({
      licenseId,
      signedPayload: licensePayload,
      signature: document.signature,
      keyId: crypto.activeSigningKeyId,
      issuedAt: new Date(licensePayload.issuedAt),
      expiresAt: new Date(licensePayload.offlineValidUntil),
      replayed: true,
      requiresSignature: false,
    });

    const response = await service.issue(principal, context, { operationId: randomUUID() });

    expect(response.replayed).toBe(true);
    expect(response.license).toEqual(document);
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('keeps request identity stable across signing-key rotation', async () => {
    const operationId = randomUUID();
    repository.prepare.mockRejectedValue(new Error('stop after request preparation'));

    await expect(service.issue(principal, context, { operationId })).rejects.toThrow(
      'stop after request preparation',
    );
    const firstInput = repository.prepare.mock.calls[0]?.[2];

    service = new OfflineLicenseService(
      database,
      repository as unknown as OfflineLicenseRepository,
      cryptoFixture('service-v2'),
    );
    await expect(service.issue(principal, context, { operationId })).rejects.toThrow(
      'stop after request preparation',
    );
    const rotatedInput = repository.prepare.mock.calls[1]?.[2];

    expect(rotatedInput?.requestHash).toBe(firstInput?.requestHash);
    expect(rotatedInput?.keyId).not.toBe(firstInput?.keyId);
  });

  it('rejects a principal/context mismatch before database access', async () => {
    await expect(
      service.issue({ ...principal, deviceId: randomUUID() }, context, {
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'OFFLINE_LICENSE_FORBIDDEN' } });
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
