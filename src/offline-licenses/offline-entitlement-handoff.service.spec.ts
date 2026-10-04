import { generateKeyPairSync, randomUUID } from 'node:crypto';

import type { AppConfigService } from '../config/app-config.service';
import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { OfflineEntitlementHandoffService } from './offline-entitlement-handoff.service';
import { OfflineLicenseCryptoService } from './offline-license-crypto';
import type { OfflineLicenseRepository } from './offline-license.repository';
import type {
  OfflineEntitlementSyncEnvelope,
  OfflineLicensePayloadV1,
} from './offline-license.types';

const transaction = {} as DatabaseTransaction;

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'handoff-v1';
  const crypto = new OfflineLicenseCryptoService({
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
  const context: TenantTransactionContext = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  const payload: OfflineLicensePayloadV1 = {
    licenseVersion: 1,
    licenseId: randomUUID(),
    storeId: context.storeId,
    deviceId: context.deviceId,
    subscriptionId: randomUUID(),
    subscriptionVersion: '9',
    issuedAt: '2026-10-04T00:00:00.000000Z',
    offlineValidUntil: '2026-10-11T00:00:00.000000Z',
    centralEntitlementEnd: '2026-10-20T00:00:00.000000Z',
    storeEntitlement: {
      storeStatus: 'active',
      subscriptionStatus: 'active',
      effectiveAccess: 'write',
    },
    signingKeyId: keyId,
  };
  const license = crypto.sign(payload);
  const envelope: OfflineEntitlementSyncEnvelope = {
    storeId: payload.storeId,
    deviceId: payload.deviceId,
    operationId: randomUUID(),
    licenseId: payload.licenseId,
    licenseVersion: 1,
    signingKeyId: payload.signingKeyId,
    subscriptionId: payload.subscriptionId,
    subscriptionVersion: payload.subscriptionVersion,
    clientRecordedAt: '2026-10-05T00:00:00.000Z',
    trustedTimeState: 'trusted',
    license,
  };
  return { context, crypto, payload, license, envelope };
}

describe('OfflineEntitlementHandoffService', () => {
  it('keeps a valid in-window operation eligible after later License expiry', async () => {
    const { context, crypto, payload, license, envelope } = fixture();
    const repository = {
      readForValidation: jest.fn().mockResolvedValue({
        licenseId: payload.licenseId,
        deviceId: payload.deviceId,
        subscriptionId: payload.subscriptionId,
        signedPayload: payload,
        signature: license.signature,
        keyId: payload.signingKeyId,
        issuedAt: new Date(payload.issuedAt),
        expiresAt: new Date(payload.offlineValidUntil),
        revokedAt: null,
        revokeReason: null,
      }),
    };
    const database = {
      withTenantTransaction: jest.fn(
        async (
          _context: TenantTransactionContext,
          work: (value: DatabaseTransaction) => Promise<unknown>,
        ) => work(transaction),
      ),
    } as unknown as DatabaseService;
    const service = new OfflineEntitlementHandoffService(
      database,
      repository as unknown as OfflineLicenseRepository,
      crypto,
    );

    await expect(service.classify(context, envelope)).resolves.toEqual({
      disposition: 'eligible',
      reason: 'licensed_within_window',
    });
  });

  it.each([
    [
      'post-expiry operation',
      { clientRecordedAt: '2026-10-11T00:00:00.000Z' },
      'outside_license_window',
    ],
    ['Store mismatch', { storeId: randomUUID() }, 'context_mismatch'],
    ['device mismatch', { deviceId: randomUUID() }, 'context_mismatch'],
    [
      'clock rollback',
      { trustedTimeState: 'clock_rollback_suspected' as const },
      'clock_rollback_suspected',
    ],
  ])('rejects or quarantines %s', async (_name, changes, reason) => {
    const { context, crypto, envelope } = fixture();
    const database = { withTenantTransaction: jest.fn() } as unknown as DatabaseService;
    const repository = { readForValidation: jest.fn() } as unknown as OfflineLicenseRepository;
    const service = new OfflineEntitlementHandoffService(database, repository, crypto);

    await expect(service.classify(context, { ...envelope, ...changes })).resolves.toMatchObject({
      reason,
    });
  });

  it.each([
    ['unknown', undefined, 'unknown_license'],
    ['revoked', { revokedAt: new Date('2026-10-06T00:00:00Z') }, 'revoked_license'],
  ])('distinguishes an %s central License reference', async (_name, recordChange, reason) => {
    const { context, crypto, payload, license, envelope } = fixture();
    const baseRecord = {
      licenseId: payload.licenseId,
      deviceId: payload.deviceId,
      subscriptionId: payload.subscriptionId,
      signedPayload: payload,
      signature: license.signature,
      keyId: payload.signingKeyId,
      issuedAt: new Date(payload.issuedAt),
      expiresAt: new Date(payload.offlineValidUntil),
      revokedAt: null,
      revokeReason: null,
    };
    const repository = {
      readForValidation: jest
        .fn()
        .mockResolvedValue(
          recordChange === undefined ? undefined : { ...baseRecord, ...recordChange },
        ),
    };
    const database = {
      withTenantTransaction: jest.fn(
        async (
          _context: TenantTransactionContext,
          work: (value: DatabaseTransaction) => Promise<unknown>,
        ) => work(transaction),
      ),
    } as unknown as DatabaseService;
    const service = new OfflineEntitlementHandoffService(
      database,
      repository as unknown as OfflineLicenseRepository,
      crypto,
    );

    await expect(service.classify(context, envelope)).resolves.toMatchObject({ reason });
  });
});
