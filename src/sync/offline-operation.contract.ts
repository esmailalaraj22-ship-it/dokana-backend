import { isUuid } from '../common/logging/request-id';
import type { SignedOfflineLicense } from '../offline-licenses/offline-license.types';
import {
  syncJsonHash,
  type SyncJsonObject,
  type SyncJsonValue,
} from './offline-operation-canonical-json';

const INT8_MAX = 9_223_372_036_854_775_807n;
const operationTypePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$/;
const decimalPattern = /^[1-9][0-9]*$/;

export type OfflineOperationResultStatus =
  'APPLIED' | 'EXACT_REPLAY' | 'REJECTED' | 'DEPENDENCY_PENDING' | 'CONFLICT' | 'QUARANTINED';

export interface OfflineTrustedTimeEvidenceV1 {
  version: 1;
  trustedServerTime: string;
  observedDeviceTime: string;
  clockState: 'trusted' | 'clock_rollback_suspected';
  knownStoreStatus: 'active' | 'read_only' | 'suspended';
  knownStoreStatusAt: string;
}

export interface OfflineOperationEnvelopeV1 {
  protocolVersion: 1;
  operationId: string;
  operationType: string;
  storeId: string;
  deviceId: string;
  aggregateId?: string;
  expectedVersion?: string;
  clientRecordedAt: string;
  payload: SyncJsonObject;
  offlineLicenseId: string;
  signedLicense: SignedOfflineLicense;
  signingKeyId: string;
  subscriptionId: string;
  subscriptionVersion: string;
  trustedTimeEvidence: OfflineTrustedTimeEvidenceV1;
  localSequence: string;
  dependsOnOperationIds: string[];
  provenanceHash: string;
}

export interface OfflineOperationPushResult {
  operationId: string | null;
  status: OfflineOperationResultStatus;
  code: string | null;
  response: SyncJsonObject | null;
}

export class OfflineOperationEnvelopeError extends Error {
  constructor(readonly code: string) {
    super('Offline operation envelope validation failed.');
    this.name = 'OfflineOperationEnvelopeError';
  }
}

export function parseOfflineOperationEnvelope(value: unknown): OfflineOperationEnvelopeV1 {
  const input = plainObject(value);
  assertExactKeys(
    input,
    [
      'protocolVersion',
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
    ],
    ['aggregateId', 'expectedVersion', 'dependsOnOperationIds'],
  );
  if (input.protocolVersion !== 1)
    throw new OfflineOperationEnvelopeError('SYNC_PROTOCOL_UNSUPPORTED');

  const operationId = canonicalUuid(input.operationId);
  const storeId = canonicalUuid(input.storeId);
  const deviceId = canonicalUuid(input.deviceId);
  const offlineLicenseId = canonicalUuid(input.offlineLicenseId);
  const subscriptionId = canonicalUuid(input.subscriptionId);
  const operationType = requiredString(input.operationType);
  if (!operationTypePattern.test(operationType) || operationType.length > 128) {
    throw new OfflineOperationEnvelopeError('SYNC_OPERATION_TYPE_INVALID');
  }
  const aggregateId =
    input.aggregateId === undefined ? undefined : canonicalUuid(input.aggregateId);
  const expectedVersion =
    input.expectedVersion === undefined
      ? undefined
      : positiveDecimal(input.expectedVersion, 'SYNC_EXPECTED_VERSION_INVALID');
  const clientRecordedAt = timestamp(input.clientRecordedAt);
  const payload = jsonObject(input.payload);
  const signedLicense = plainObject(input.signedLicense) as unknown as SignedOfflineLicense;
  const signingKeyId = requiredString(input.signingKeyId);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(signingKeyId)) {
    throw new OfflineOperationEnvelopeError('SYNC_LICENSE_BINDING_INVALID');
  }
  const subscriptionVersion = positiveDecimal(
    input.subscriptionVersion,
    'SYNC_SUBSCRIPTION_VERSION_INVALID',
  );
  const localSequence = positiveDecimal(input.localSequence, 'SYNC_LOCAL_SEQUENCE_INVALID', true);
  const trustedTimeEvidence = parseTrustedTimeEvidence(input.trustedTimeEvidence);
  const dependsOnOperationIds = parseDependencies(input.dependsOnOperationIds, operationId);

  const material = {
    protocolVersion: 1,
    operationId,
    operationType,
    storeId,
    deviceId,
    aggregateId: aggregateId ?? null,
    expectedVersion: expectedVersion ?? null,
    clientRecordedAt,
    payload,
    offlineLicenseId,
    signingKeyId,
    subscriptionId,
    subscriptionVersion,
    localSequence,
    dependsOnOperationIds,
  } satisfies SyncJsonObject;

  return {
    protocolVersion: 1,
    operationId,
    operationType,
    storeId,
    deviceId,
    ...(aggregateId === undefined ? {} : { aggregateId }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    clientRecordedAt,
    payload,
    offlineLicenseId,
    signedLicense,
    signingKeyId,
    subscriptionId,
    subscriptionVersion,
    trustedTimeEvidence,
    localSequence,
    dependsOnOperationIds,
    provenanceHash: syncJsonHash(material),
  };
}

function parseTrustedTimeEvidence(value: unknown): OfflineTrustedTimeEvidenceV1 {
  const input = plainObject(value);
  assertExactKeys(input, [
    'version',
    'trustedServerTime',
    'observedDeviceTime',
    'clockState',
    'knownStoreStatus',
    'knownStoreStatusAt',
  ]);
  if (
    input.version !== 1 ||
    (input.clockState !== 'trusted' && input.clockState !== 'clock_rollback_suspected') ||
    !['active', 'read_only', 'suspended'].includes(String(input.knownStoreStatus))
  ) {
    throw new OfflineOperationEnvelopeError('SYNC_TRUSTED_TIME_INVALID');
  }
  return {
    version: 1,
    trustedServerTime: timestamp(input.trustedServerTime),
    observedDeviceTime: timestamp(input.observedDeviceTime),
    clockState: input.clockState,
    knownStoreStatus: input.knownStoreStatus as OfflineTrustedTimeEvidenceV1['knownStoreStatus'],
    knownStoreStatusAt: timestamp(input.knownStoreStatusAt),
  };
}

function parseDependencies(value: unknown, operationId: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new OfflineOperationEnvelopeError('SYNC_DEPENDENCIES_INVALID');
  }
  const dependencies = value.map(canonicalUuid).sort();
  if (dependencies.includes(operationId) || new Set(dependencies).size !== dependencies.length) {
    throw new OfflineOperationEnvelopeError('SYNC_DEPENDENCIES_INVALID');
  }
  return dependencies;
}

function positiveDecimal(value: unknown, code: string, enforceInt8 = false): string {
  if (typeof value !== 'string' || !decimalPattern.test(value)) {
    throw new OfflineOperationEnvelopeError(code);
  }
  if (enforceInt8 && BigInt(value) > INT8_MAX) throw new OfflineOperationEnvelopeError(code);
  return value;
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value) || value !== value.toLowerCase()) {
    throw new OfflineOperationEnvelopeError('SYNC_IDENTIFIER_INVALID');
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    throw new OfflineOperationEnvelopeError('SYNC_TIMESTAMP_INVALID');
  }
  return new Date(value).toISOString();
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OfflineOperationEnvelopeError('SYNC_ENVELOPE_INVALID');
  }
  return value;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OfflineOperationEnvelopeError('SYNC_ENVELOPE_INVALID');
  }
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown): SyncJsonObject {
  const object = plainObject(value);
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, jsonValue(entry)]));
}

function jsonValue(value: unknown): SyncJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object') return jsonObject(value);
  throw new OfflineOperationEnvelopeError('SYNC_PAYLOAD_INVALID');
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new OfflineOperationEnvelopeError('SYNC_ENVELOPE_INVALID');
  }
}
