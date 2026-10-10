import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';
import type { OfflineOperationEnvelopeV1 } from './offline-operation.contract';
import type { SyncJsonObject } from './offline-operation-canonical-json';

export interface BeginOfflineOperationResult {
  disposition:
    'authorized' | 'exact_replay' | 'rejected' | 'dependency_pending' | 'conflict' | 'quarantined';
  reasonCode: string | null;
  responseBody: SyncJsonObject | null;
  processedOperationPreexisted: boolean;
}

export interface FinishOfflineOperationResult {
  disposition: 'applied' | 'rejected' | 'conflict' | 'quarantined';
  canonicalRequestHash: string | null;
  responseBody: SyncJsonObject;
}

@Injectable()
export class OfflineOperationRepository {
  async begin(
    transaction: DatabaseTransaction,
    envelope: OfflineOperationEnvelopeV1,
  ): Promise<BeginOfflineOperationResult> {
    const evidence = envelope.trustedTimeEvidence;
    const dependencies = `{${envelope.dependsOnOperationIds.join(',')}}`;
    const result = await transaction.execute(sql`
      select
        disposition,
        reason_code as "reasonCode",
        response_body as "responseBody",
        processed_operation_preexisted as "processedOperationPreexisted"
      from sync.begin_offline_operation_v1(
        ${envelope.storeId}::uuid,
        ${envelope.deviceId}::uuid,
        ${envelope.operationId}::uuid,
        ${envelope.operationType}::text,
        ${envelope.localSequence}::bigint,
        ${envelope.provenanceHash}::text,
        ${envelope.offlineLicenseId}::uuid,
        ${envelope.subscriptionId}::uuid,
        ${envelope.subscriptionVersion}::bigint,
        ${envelope.clientRecordedAt}::timestamptz,
        ${evidence.trustedServerTime}::timestamptz,
        ${evidence.observedDeviceTime}::timestamptz,
        ${evidence.clockState}::text,
        ${evidence.knownStoreStatus}::text,
        ${evidence.knownStoreStatusAt}::timestamptz,
        ${dependencies}::uuid[]
      )
    `);
    const row = result.rows[0] as BeginOfflineOperationResult | undefined;
    if (!row) throw new Error('Offline operation authorization returned no result.');
    return row;
  }

  async finish(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    disposition: FinishOfflineOperationResult['disposition'],
    responseBody: SyncJsonObject,
  ): Promise<FinishOfflineOperationResult> {
    const result = await transaction.execute(sql`
      select
        disposition,
        canonical_request_hash as "canonicalRequestHash",
        response_body as "responseBody"
      from sync.finish_offline_operation_v1(
        ${storeId}::uuid,
        ${operationId}::uuid,
        ${disposition}::text,
        ${JSON.stringify(responseBody)}::jsonb
      )
    `);
    const row = result.rows[0] as FinishOfflineOperationResult | undefined;
    if (!row) throw new Error('Offline operation completion returned no result.');
    return row;
  }
}
