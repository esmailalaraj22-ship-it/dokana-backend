import { Injectable } from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import {
  canonicalizeOfflineLicensePayload,
  OfflineLicenseCryptoService,
} from './offline-license-crypto';
import { OfflineLicenseRepository } from './offline-license.repository';
import type {
  OfflineEntitlementClassification,
  OfflineEntitlementSyncEnvelope,
} from './offline-license.types';

@Injectable()
export class OfflineEntitlementHandoffService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OfflineLicenseRepository,
    private readonly crypto: OfflineLicenseCryptoService,
  ) {}

  async classify(
    context: TenantTransactionContext,
    envelope: OfflineEntitlementSyncEnvelope,
  ): Promise<OfflineEntitlementClassification> {
    if (context.storeId !== envelope.storeId || context.deviceId !== envelope.deviceId) {
      return { disposition: 'reject', reason: 'context_mismatch' };
    }
    if (
      !isUuid(envelope.operationId) ||
      !isUuid(envelope.licenseId) ||
      Number.isNaN(Date.parse(envelope.clientRecordedAt))
    ) {
      return { disposition: 'reject', reason: 'invalid_envelope' };
    }
    if (envelope.trustedTimeState === 'clock_rollback_suspected') {
      return { disposition: 'quarantine', reason: 'clock_rollback_suspected' };
    }

    let payload;
    try {
      payload = this.crypto.verify(envelope.license);
    } catch {
      return { disposition: 'reject', reason: 'invalid_license' };
    }
    if (
      payload.licenseId !== envelope.licenseId ||
      payload.storeId !== envelope.storeId ||
      payload.deviceId !== envelope.deviceId ||
      payload.signingKeyId !== envelope.signingKeyId ||
      payload.subscriptionId !== envelope.subscriptionId ||
      payload.subscriptionVersion !== envelope.subscriptionVersion
    ) {
      return { disposition: 'reject', reason: 'invalid_license' };
    }

    const createdAt = Date.parse(envelope.clientRecordedAt);
    if (
      createdAt < Date.parse(payload.issuedAt) ||
      createdAt >= Date.parse(payload.offlineValidUntil)
    ) {
      return { disposition: 'reject', reason: 'outside_license_window' };
    }

    const record = await this.database.withTenantTransaction(context, (transaction) =>
      this.repository.readForValidation(transaction, context, envelope.licenseId),
    );
    if (!record) return { disposition: 'reject', reason: 'unknown_license' };
    if (record.revokedAt) return { disposition: 'reject', reason: 'revoked_license' };
    if (
      record.deviceId !== envelope.deviceId ||
      record.subscriptionId !== envelope.subscriptionId ||
      record.keyId !== envelope.signingKeyId ||
      record.signature !== envelope.license.signature ||
      canonicalizeOfflineLicensePayload(record.signedPayload) !==
        canonicalizeOfflineLicensePayload(payload)
    ) {
      return { disposition: 'reject', reason: 'invalid_license' };
    }
    return { disposition: 'eligible', reason: 'licensed_within_window' };
  }
}
