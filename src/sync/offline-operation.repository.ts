import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';
import type { OfflineOperationEnvelopeV1 } from './offline-operation.contract';
import type { SyncJsonObject } from './offline-operation-canonical-json';

export interface BeginOfflineOperationResult {
  disposition:
    | 'authorized'
    | 'applied'
    | 'exact_replay'
    | 'rejected'
    | 'dependency_pending'
    | 'conflict'
    | 'quarantined';
  reasonCode: string | null;
  responseBody: SyncJsonObject | null;
  processedOperationPreexisted: boolean;
}

export interface FinishOfflineOperationResult {
  disposition: 'applied' | 'rejected' | 'conflict' | 'quarantined';
  canonicalRequestHash: string | null;
  responseBody: SyncJsonObject;
}

export interface OfflineOperationStatusRow {
  operationId: string;
  status:
    'applied' | 'exact_replay' | 'rejected' | 'dependency_pending' | 'conflict' | 'quarantined';
  reasonCode: string | null;
  responseBody: SyncJsonObject | null;
  recoveryEligible: boolean;
  recoveryAttemptCount: number;
  lastRecoveryAt: Date | string | null;
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
      from sync.begin_offline_operation_v2(
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

  async readStatus(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    provenanceHash: string | null,
  ): Promise<OfflineOperationStatusRow | null> {
    const result = await transaction.execute(sql`
      select
        operation_id as "operationId",
        status,
        reason_code as "reasonCode",
        response_body as "responseBody",
        recovery_eligible as "recoveryEligible",
        recovery_attempt_count as "recoveryAttemptCount",
        last_recovery_at as "lastRecoveryAt"
      from sync.read_offline_operation_status_v1(
        ${storeId}::uuid,
        ${operationId}::uuid,
        ${provenanceHash}::text
      )
    `);
    return (result.rows[0] as OfflineOperationStatusRow | undefined) ?? null;
  }

  async beginRecovery(
    transaction: DatabaseTransaction,
    envelope: OfflineOperationEnvelopeV1,
    recoveryAttemptId: string,
  ): Promise<BeginOfflineOperationResult> {
    const evidence = envelope.trustedTimeEvidence;
    const dependencies = `{${envelope.dependsOnOperationIds.join(',')}}`;
    const result = await transaction.execute(sql`
      select
        disposition,
        reason_code as "reasonCode",
        response_body as "responseBody",
        processed_operation_preexisted as "processedOperationPreexisted"
      from sync.begin_offline_operation_recovery_v1(
        ${envelope.storeId}::uuid,
        ${envelope.deviceId}::uuid,
        ${envelope.operationId}::uuid,
        ${recoveryAttemptId}::uuid,
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
    if (!row) throw new Error('Offline operation recovery authorization returned no result.');
    return row;
  }

  async finishRecovery(
    transaction: DatabaseTransaction,
    storeId: string,
    operationId: string,
    recoveryAttemptId: string,
    disposition: FinishOfflineOperationResult['disposition'],
    responseBody: SyncJsonObject,
  ): Promise<FinishOfflineOperationResult> {
    const result = await transaction.execute(sql`
      select
        disposition,
        canonical_request_hash as "canonicalRequestHash",
        response_body as "responseBody"
      from sync.finish_offline_operation_recovery_v1(
        ${storeId}::uuid,
        ${operationId}::uuid,
        ${recoveryAttemptId}::uuid,
        ${disposition}::text,
        ${JSON.stringify(responseBody)}::jsonb
      )
    `);
    const row = result.rows[0] as FinishOfflineOperationResult | undefined;
    if (!row) throw new Error('Offline operation recovery completion returned no result.');
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
