import { generateKeyPairSync, randomUUID } from 'node:crypto';

import type { AppConfigService } from '../config/app-config.service';
import { OfflineLicenseCryptoService } from './offline-license-crypto';
import { evaluateTrustedOfflineAccess } from './offline-license-trusted-time';
import type { OfflineLicensePayloadV1 } from './offline-license.types';

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'trusted-time-v1';
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
  const payload: OfflineLicensePayloadV1 = {
    licenseVersion: 1,
    licenseId: randomUUID(),
    storeId: randomUUID(),
    deviceId: randomUUID(),
    subscriptionId: randomUUID(),
    subscriptionVersion: '3',
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
  return {
    crypto,
    payload,
    document: crypto.sign(payload),
    binding: {
      storeId: payload.storeId,
      deviceId: payload.deviceId,
      subscriptionId: payload.subscriptionId,
      subscriptionVersion: payload.subscriptionVersion,
    },
  };
}

describe('Offline License trusted-time contract', () => {
  it('allows writes only before the exclusive authoritative expiry boundary', () => {
    const { crypto, document, binding } = fixture();
    expect(
      evaluateTrustedOfflineAccess(
        crypto,
        document,
        binding,
        new Date('2026-10-10T23:59:59.999Z'),
        false,
      ),
    ).toEqual({ access: 'write', onlineRevalidationRequired: false, reason: null });
    expect(
      evaluateTrustedOfflineAccess(
        crypto,
        document,
        binding,
        new Date('2026-10-11T00:00:00.000Z'),
        false,
      ),
    ).toMatchObject({ access: 'read_only', reason: 'license_expired' });
  });

  it('fails to read-only on clock rollback, pre-issuance time, or binding mismatch', () => {
    const { crypto, document, binding } = fixture();
    expect(
      evaluateTrustedOfflineAccess(
        crypto,
        document,
        binding,
        new Date('2026-10-05T00:00:00Z'),
        true,
      ),
    ).toMatchObject({ access: 'read_only', reason: 'clock_rollback' });
    expect(
      evaluateTrustedOfflineAccess(
        crypto,
        document,
        binding,
        new Date('2026-10-03T23:59:59Z'),
        false,
      ),
    ).toMatchObject({ access: 'read_only', reason: 'untrusted_time' });
    expect(
      evaluateTrustedOfflineAccess(
        crypto,
        document,
        { ...binding, deviceId: randomUUID() },
        new Date('2026-10-05T00:00:00Z'),
        false,
      ),
    ).toMatchObject({ access: 'read_only', reason: 'invalid_license' });
  });
});
