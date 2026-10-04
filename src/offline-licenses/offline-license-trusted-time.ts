import type { OfflineLicenseCryptoService } from './offline-license-crypto';
import type { SignedOfflineLicense } from './offline-license.types';

export interface OfflineLicenseBinding {
  storeId: string;
  deviceId: string;
  subscriptionId: string;
  subscriptionVersion: string;
}

export type TrustedOfflineAccess =
  | { access: 'write'; onlineRevalidationRequired: false; reason: null }
  | {
      access: 'read_only';
      onlineRevalidationRequired: true;
      reason: 'invalid_license' | 'untrusted_time' | 'clock_rollback' | 'license_expired';
    };

export function evaluateTrustedOfflineAccess(
  crypto: OfflineLicenseCryptoService,
  document: SignedOfflineLicense,
  binding: OfflineLicenseBinding,
  trustedTime: Date,
  clockRollbackSuspected: boolean,
): TrustedOfflineAccess {
  if (clockRollbackSuspected) {
    return { access: 'read_only', onlineRevalidationRequired: true, reason: 'clock_rollback' };
  }
  try {
    const payload = crypto.verify(document);
    if (
      payload.storeId !== binding.storeId ||
      payload.deviceId !== binding.deviceId ||
      payload.subscriptionId !== binding.subscriptionId ||
      payload.subscriptionVersion !== binding.subscriptionVersion
    ) {
      return { access: 'read_only', onlineRevalidationRequired: true, reason: 'invalid_license' };
    }
    const now = trustedTime.getTime();
    if (now < Date.parse(payload.issuedAt)) {
      return { access: 'read_only', onlineRevalidationRequired: true, reason: 'untrusted_time' };
    }
    if (now >= Date.parse(payload.offlineValidUntil)) {
      return { access: 'read_only', onlineRevalidationRequired: true, reason: 'license_expired' };
    }
    return { access: 'write', onlineRevalidationRequired: false, reason: null };
  } catch {
    return { access: 'read_only', onlineRevalidationRequired: true, reason: 'invalid_license' };
  }
}
