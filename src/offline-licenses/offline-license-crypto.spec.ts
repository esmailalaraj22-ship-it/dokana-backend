import { generateKeyPairSync, randomUUID } from 'node:crypto';

import type { AppConfigService } from '../config/app-config.service';
import {
  canonicalizeOfflineLicensePayload,
  OfflineLicenseCryptoService,
} from './offline-license-crypto';
import type { OfflineLicensePayloadV1 } from './offline-license.types';

function keyMaterial() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  };
}

function cryptoService(
  activeKeyId: string,
  active: ReturnType<typeof keyMaterial>,
  publicKeys: Record<string, string> = { [activeKeyId]: active.publicKey },
): OfflineLicenseCryptoService {
  return new OfflineLicenseCryptoService({
    offlineLicenseSigning: {
      activeKeyId,
      activePrivateKeyPkcs8: active.privateKey,
      publicKeys,
    },
  } as AppConfigService);
}

function payload(keyId = 'offline-v1'): OfflineLicensePayloadV1 {
  return {
    licenseVersion: 1,
    licenseId: randomUUID(),
    storeId: randomUUID(),
    deviceId: randomUUID(),
    subscriptionId: randomUUID(),
    subscriptionVersion: '7',
    issuedAt: '2026-10-04T10:00:00.000000Z',
    offlineValidUntil: '2026-10-11T10:00:00.000000Z',
    centralEntitlementEnd: '2026-11-01T10:00:00.000000Z',
    storeEntitlement: {
      storeStatus: 'active',
      subscriptionStatus: 'active',
      effectiveAccess: 'write',
    },
    signingKeyId: keyId,
  };
}

describe('OfflineLicenseCryptoService', () => {
  it('signs and verifies a deterministic canonical Ed25519 License', () => {
    const keys = keyMaterial();
    const crypto = cryptoService('offline-v1', keys);
    const licensePayload = payload();
    const document = crypto.sign(licensePayload);

    expect(crypto.verify(document)).toEqual(licensePayload);
    expect(document.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(canonicalizeOfflineLicensePayload({ ...licensePayload })).toBe(
      canonicalizeOfflineLicensePayload(licensePayload),
    );
  });

  it.each(['storeId', 'deviceId', 'subscriptionId'] as const)(
    'rejects signed %s substitution',
    (field) => {
      const keys = keyMaterial();
      const crypto = cryptoService('offline-v1', keys);
      const document = crypto.sign(payload());
      const tampered = {
        ...document,
        payload: { ...document.payload, [field]: randomUUID() },
      };
      expect(() => crypto.verify(tampered)).toThrow('Offline License verification failed.');
    },
  );

  it('rejects Subscription version, payload, and signature tampering', () => {
    const keys = keyMaterial();
    const crypto = cryptoService('offline-v1', keys);
    const document = crypto.sign(payload());

    expect(() =>
      crypto.verify({
        ...document,
        payload: { ...document.payload, subscriptionVersion: '8' },
      }),
    ).toThrow('Offline License verification failed.');
    const replacement = document.signature.startsWith('A') ? 'B' : 'A';
    expect(() =>
      crypto.verify({ ...document, signature: `${replacement}${document.signature.slice(1)}` }),
    ).toThrow('Offline License verification failed.');
  });

  it('rejects a wrong or unknown verification key', () => {
    const first = keyMaterial();
    const second = keyMaterial();
    const document = cryptoService('offline-v1', first).sign(payload());

    expect(() => cryptoService('offline-v1', second).verify(document)).toThrow(
      'Offline License verification failed.',
    );
    const unknown = cryptoService('offline-v2', second, { 'offline-v2': second.publicKey });
    expect(() => unknown.verify(document)).toThrow('Offline License verification failed.');
  });

  it('keeps retired public keys verification-only during rotation', () => {
    const oldKeys = keyMaterial();
    const newKeys = keyMaterial();
    const oldDocument = cryptoService('offline-v1', oldKeys).sign(payload('offline-v1'));
    const rotated = cryptoService('offline-v2', newKeys, {
      'offline-v1': oldKeys.publicKey,
      'offline-v2': newKeys.publicKey,
    });

    expect(rotated.verify(oldDocument).licenseId).toBe(oldDocument.payload.licenseId);
    expect(() => rotated.sign(payload('offline-v1'))).toThrow(
      'Offline License verification failed.',
    );
    expect(rotated.sign(payload('offline-v2')).payload.signingKeyId).toBe('offline-v2');
  });

  it('fails closed when the active private and public keys do not match', () => {
    const first = keyMaterial();
    const second = keyMaterial();
    expect(() => cryptoService('offline-v1', first, { 'offline-v1': second.publicKey })).toThrow(
      'Offline License signing configuration is invalid.',
    );
  });
});
