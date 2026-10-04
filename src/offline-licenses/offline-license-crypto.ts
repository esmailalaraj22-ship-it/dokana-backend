import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import { AppConfigService } from '../config/app-config.service';
import type {
  OfflineLicensePayloadV1,
  OfflineLicenseVerificationKey,
  SignedOfflineLicense,
} from './offline-license.types';

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | CanonicalJsonObject;
interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJson;
}

const keyIdPattern = /^[A-Za-z0-9._-]{1,64}$/;
const decimalVersionPattern = /^[1-9]\d*$/;
const payloadKeys = [
  'centralEntitlementEnd',
  'deviceId',
  'issuedAt',
  'licenseId',
  'licenseVersion',
  'offlineValidUntil',
  'signingKeyId',
  'storeEntitlement',
  'storeId',
  'subscriptionId',
  'subscriptionVersion',
] as const;

export class OfflineLicenseVerificationError extends Error {
  constructor() {
    super('Offline License verification failed.');
    this.name = 'OfflineLicenseVerificationError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && !Number.isNaN(Date.parse(value));
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value) && value === value.toLowerCase();
}

export function parseOfflineLicensePayload(value: unknown): OfflineLicensePayloadV1 {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !== [...payloadKeys].sort().join(',')
  ) {
    throw new OfflineLicenseVerificationError();
  }
  const entitlement = value.storeEntitlement;
  if (
    value.licenseVersion !== 1 ||
    !isCanonicalUuid(value.licenseId) ||
    !isCanonicalUuid(value.storeId) ||
    !isCanonicalUuid(value.deviceId) ||
    !isCanonicalUuid(value.subscriptionId) ||
    typeof value.subscriptionVersion !== 'string' ||
    !decimalVersionPattern.test(value.subscriptionVersion) ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.offlineValidUntil) ||
    !isTimestamp(value.centralEntitlementEnd) ||
    typeof value.signingKeyId !== 'string' ||
    !keyIdPattern.test(value.signingKeyId) ||
    !isObject(entitlement) ||
    Object.keys(entitlement).sort().join(',') !==
      ['effectiveAccess', 'storeStatus', 'subscriptionStatus'].join(',') ||
    entitlement.storeStatus !== 'active' ||
    entitlement.subscriptionStatus !== 'active' ||
    entitlement.effectiveAccess !== 'write'
  ) {
    throw new OfflineLicenseVerificationError();
  }
  const issuedAt = Date.parse(value.issuedAt);
  const offlineValidUntil = Date.parse(value.offlineValidUntil);
  const centralEntitlementEnd = Date.parse(value.centralEntitlementEnd);
  if (
    offlineValidUntil <= issuedAt ||
    offlineValidUntil > centralEntitlementEnd ||
    offlineValidUntil - issuedAt > 168 * 60 * 60 * 1_000
  ) {
    throw new OfflineLicenseVerificationError();
  }
  return value as unknown as OfflineLicensePayloadV1;
}

function canonicalize(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] ?? null)}`)
    .join(',')}}`;
}

export function canonicalizeOfflineLicensePayload(payload: OfflineLicensePayloadV1): string {
  return canonicalize(payload as unknown as CanonicalJsonObject);
}

@Injectable()
export class OfflineLicenseCryptoService {
  private readonly activeKeyId: string;
  private readonly privateKey: KeyObject;
  private readonly publicKeys = new Map<string, { encoded: string; key: KeyObject }>();

  constructor(config: AppConfigService) {
    const signing = config.offlineLicenseSigning;
    this.activeKeyId = signing.activeKeyId;
    try {
      this.privateKey = createPrivateKey({
        key: Buffer.from(signing.activePrivateKeyPkcs8, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      });
      if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Unexpected key type.');

      for (const [keyId, encoded] of Object.entries(signing.publicKeys)) {
        const key = createPublicKey({
          key: Buffer.from(encoded, 'base64url'),
          format: 'der',
          type: 'spki',
        });
        if (key.asymmetricKeyType !== 'ed25519') throw new Error('Unexpected key type.');
        this.publicKeys.set(keyId, { encoded, key });
      }

      const configuredActive = this.publicKeys.get(this.activeKeyId);
      const derivedActive = createPublicKey(this.privateKey).export({
        format: 'der',
        type: 'spki',
      });
      if (
        !configuredActive ||
        !derivedActive.equals(
          configuredActive.key.export({
            format: 'der',
            type: 'spki',
          }),
        )
      ) {
        throw new Error('Active public key does not match private key.');
      }
    } catch {
      throw new Error('Offline License signing configuration is invalid.');
    }
  }

  get activeSigningKeyId(): string {
    return this.activeKeyId;
  }

  sign(payloadValue: unknown): SignedOfflineLicense {
    const payload = parseOfflineLicensePayload(payloadValue);
    if (payload.signingKeyId !== this.activeKeyId) {
      throw new OfflineLicenseVerificationError();
    }
    const signature = signBytes(
      null,
      Buffer.from(canonicalizeOfflineLicensePayload(payload), 'utf8'),
      this.privateKey,
    ).toString('base64url');
    return { algorithm: 'Ed25519', payload, signature };
  }

  verify(document: unknown): OfflineLicensePayloadV1 {
    if (
      !isObject(document) ||
      document.algorithm !== 'Ed25519' ||
      typeof document.signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(document.signature)
    ) {
      throw new OfflineLicenseVerificationError();
    }
    const payload = parseOfflineLicensePayload(document.payload);
    const publicKey = this.publicKeys.get(payload.signingKeyId)?.key;
    if (
      !publicKey ||
      !verifyBytes(
        null,
        Buffer.from(canonicalizeOfflineLicensePayload(payload), 'utf8'),
        publicKey,
        Buffer.from(document.signature, 'base64url'),
      )
    ) {
      throw new OfflineLicenseVerificationError();
    }
    return payload;
  }

  verificationKey(keyId: string): OfflineLicenseVerificationKey {
    const key = this.publicKeys.get(keyId);
    if (!key) throw new OfflineLicenseVerificationError();
    return { algorithm: 'Ed25519', keyId, publicKeySpki: key.encoded };
  }
}
