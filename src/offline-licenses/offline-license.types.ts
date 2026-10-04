import type { TenantTransactionContext } from '../database/database.types';

export interface OfflineLicensePayloadV1 {
  licenseVersion: 1;
  licenseId: string;
  storeId: string;
  deviceId: string;
  subscriptionId: string;
  subscriptionVersion: string;
  issuedAt: string;
  offlineValidUntil: string;
  centralEntitlementEnd: string;
  storeEntitlement: {
    storeStatus: 'active';
    subscriptionStatus: 'active';
    effectiveAccess: 'write';
  };
  signingKeyId: string;
}

export interface SignedOfflineLicense {
  algorithm: 'Ed25519';
  payload: OfflineLicensePayloadV1;
  signature: string;
}

export interface OfflineLicenseVerificationKey {
  algorithm: 'Ed25519';
  keyId: string;
  publicKeySpki: string;
}

export interface OfflineLicenseResponse {
  operationId: string;
  replayed: boolean;
  serverTime: string;
  subscriptionValidUntil: string;
  nextOnlineVerificationRequiredAt: string;
  license: SignedOfflineLicense;
  verificationKey: OfflineLicenseVerificationKey;
  trustedTime: {
    lastTrustedServerTime: string;
    offlineValidUntil: string;
    expiryBoundary: 'exclusive';
    clockRollbackPolicy: 'read_only_and_online_revalidation_required';
  };
}

export interface OfflineLicenseDatabaseRecord {
  licenseId: string;
  signedPayload: OfflineLicensePayloadV1;
  signature: string;
  keyId: string;
  issuedAt: Date;
  expiresAt: Date;
  replayed: boolean;
}

export interface PreparedOfflineLicenseRecord extends OfflineLicenseDatabaseRecord {
  requiresSignature: boolean;
}

export interface OfflineLicenseValidationRecord {
  licenseId: string;
  deviceId: string;
  subscriptionId: string;
  signedPayload: OfflineLicensePayloadV1;
  signature: string;
  keyId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
}

export type OfflineLicenseStatus = 'active' | 'expired' | 'revoked';

export interface OfflineLicenseAdminListRecord {
  checkedAt: Date;
  licenseId: string;
  deviceId: string;
  subscriptionId: string;
  keyId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  status: OfflineLicenseStatus;
}

export interface OfflineLicenseRevocationRecord {
  licenseId: string;
  revokedAt: Date;
  revokeReason: string;
  replayed: boolean;
}

export interface PreparedOfflineLicenseIssuance {
  licenseId: string;
  operationId: string;
  requestHash: string;
  keyId: string;
}

export interface PreparedOfflineLicenseRevocation {
  licenseId: string;
  operationId: string;
  requestHash: string;
  reason: string;
}

export interface OfflineEntitlementSyncEnvelope {
  storeId: string;
  deviceId: string;
  operationId: string;
  licenseId: string;
  licenseVersion: 1;
  signingKeyId: string;
  subscriptionId: string;
  subscriptionVersion: string;
  clientRecordedAt: string;
  trustedTimeState: 'trusted' | 'clock_rollback_suspected';
  license: SignedOfflineLicense;
}

export type OfflineEntitlementClassification =
  | { disposition: 'eligible'; reason: 'licensed_within_window' }
  | {
      disposition: 'reject' | 'quarantine';
      reason:
        | 'context_mismatch'
        | 'invalid_envelope'
        | 'invalid_license'
        | 'unknown_license'
        | 'revoked_license'
        | 'outside_license_window'
        | 'clock_rollback_suspected';
    };

export type OfflineLicenseActorContext = TenantTransactionContext;
