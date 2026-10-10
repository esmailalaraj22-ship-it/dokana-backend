import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';

import {
  OfflineOperationEnvelopeError,
  parseOfflineOperationEnvelope,
} from './offline-operation.contract';
import {
  OFFLINE_PUSH_MAX_OPERATIONS,
  PushOfflineOperationsDto,
} from './dto/push-offline-operations.dto';

function envelope(): Record<string, unknown> {
  const storeId = randomUUID();
  const deviceId = randomUUID();
  const licenseId = randomUUID();
  const subscriptionId = randomUUID();
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    operationType: 'customers.create.v1',
    storeId,
    deviceId,
    aggregateId: randomUUID(),
    clientRecordedAt: '2026-01-02T03:04:05.000Z',
    payload: { name: 'Customer', nested: { b: 'two', a: 'one' } },
    offlineLicenseId: licenseId,
    signedLicense: { algorithm: 'Ed25519', payload: {}, signature: 'x' },
    signingKeyId: 'license-v1',
    subscriptionId,
    subscriptionVersion: '1',
    trustedTimeEvidence: {
      version: 1,
      trustedServerTime: '2026-01-01T03:04:05.000Z',
      observedDeviceTime: '2026-01-02T03:04:05.000Z',
      clockState: 'trusted',
      knownStoreStatus: 'active',
      knownStoreStatusAt: '2026-01-01T03:04:05.000Z',
    },
    localSequence: '1',
    dependsOnOperationIds: [],
  };
}

describe('offline operation envelope', () => {
  it('canonicalizes equivalent payload key order to the same provenance hash', () => {
    const first = envelope();
    const second = structuredClone(first);
    second.payload = { nested: { a: 'one', b: 'two' }, name: 'Customer' };

    expect(parseOfflineOperationEnvelope(first).provenanceHash).toBe(
      parseOfflineOperationEnvelope(second).provenanceHash,
    );
  });

  it.each([
    ['unsupported protocol', { protocolVersion: 2 }],
    ['unknown envelope field', { metadata: {} }],
    ['unsafe local sequence', { localSequence: '9223372036854775808' }],
    ['non-canonical operation UUID', { operationId: randomUUID().toUpperCase() }],
  ])('rejects %s without execution', (_label, change) => {
    expect(() => parseOfflineOperationEnvelope({ ...envelope(), ...change })).toThrow(
      OfflineOperationEnvelopeError,
    );
  });

  it.each([
    'operationId',
    'operationType',
    'storeId',
    'deviceId',
    'clientRecordedAt',
    'payload',
    'offlineLicenseId',
    'signedLicense',
    'signingKeyId',
    'subscriptionId',
    'subscriptionVersion',
    'trustedTimeEvidence',
    'localSequence',
  ])('rejects an envelope missing required field %s', (field) => {
    const value = Object.fromEntries(Object.entries(envelope()).filter(([key]) => key !== field));
    expect(() => parseOfflineOperationEnvelope(value)).toThrow(OfflineOperationEnvelopeError);
  });

  it.each([
    ['store identifier', { storeId: 'not-a-uuid' }],
    ['device identifier', { deviceId: 'not-a-uuid' }],
    ['License identifier', { offlineLicenseId: 'not-a-uuid' }],
    ['Subscription identifier', { subscriptionId: 'not-a-uuid' }],
    ['aggregate identifier', { aggregateId: 'not-a-uuid' }],
  ])('rejects an invalid %s', (_label, change) => {
    expect(() => parseOfflineOperationEnvelope({ ...envelope(), ...change })).toThrow(
      OfflineOperationEnvelopeError,
    );
  });

  it.each([
    ['client timestamp', { clientRecordedAt: '2026-01-02T03:04:05+00:00' }],
    [
      'trusted-time timestamp',
      {
        trustedTimeEvidence: {
          ...(envelope().trustedTimeEvidence as Record<string, unknown>),
          observedDeviceTime: 'not-an-instant',
        },
      },
    ],
  ])('rejects an invalid %s', (_label, change) => {
    expect(() => parseOfflineOperationEnvelope({ ...envelope(), ...change })).toThrow(
      OfflineOperationEnvelopeError,
    );
  });

  it('canonicalizes dependency order and rejects duplicate, self, and excessive dependencies', () => {
    const value = envelope();
    const first = randomUUID();
    const second = randomUUID();
    value.dependsOnOperationIds = [second, first];
    expect(parseOfflineOperationEnvelope(value).dependsOnOperationIds).toEqual(
      [first, second].sort(),
    );

    value.dependsOnOperationIds = [first, first];
    expect(() => parseOfflineOperationEnvelope(value)).toThrow(OfflineOperationEnvelopeError);
    value.dependsOnOperationIds = [value.operationId];
    expect(() => parseOfflineOperationEnvelope(value)).toThrow(OfflineOperationEnvelopeError);
    value.dependsOnOperationIds = Array.from({ length: 33 }, () => randomUUID());
    expect(() => parseOfflineOperationEnvelope(value)).toThrow(OfflineOperationEnvelopeError);
  });

  it('requires positive lossless decimal versions and local sequence', () => {
    for (const change of [
      { localSequence: '0' },
      { localSequence: '01' },
      { localSequence: 1 },
      { subscriptionVersion: '0' },
      { expectedVersion: '01' },
    ]) {
      expect(() => parseOfflineOperationEnvelope({ ...envelope(), ...change })).toThrow(
        OfflineOperationEnvelopeError,
      );
    }
  });

  it('rejects unsupported payload values', () => {
    expect(() =>
      parseOfflineOperationEnvelope({ ...envelope(), payload: { unsafe: Number.NaN } }),
    ).toThrow(OfflineOperationEnvelopeError);
  });

  it('enforces the bounded non-empty push batch', async () => {
    const valid = new PushOfflineOperationsDto();
    valid.operations = Array.from({ length: OFFLINE_PUSH_MAX_OPERATIONS }, () => envelope());
    await expect(validate(valid)).resolves.toEqual([]);

    const empty = new PushOfflineOperationsDto();
    empty.operations = [];
    await expect(validate(empty)).resolves.not.toEqual([]);

    const oversized = new PushOfflineOperationsDto();
    oversized.operations = Array.from({ length: OFFLINE_PUSH_MAX_OPERATIONS + 1 }, () =>
      envelope(),
    );
    await expect(validate(oversized)).resolves.not.toEqual([]);
  });
});
