import { HttpException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { SyncAuthenticatedPrincipal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import { OfflineLicenseCryptoService } from '../offline-licenses/offline-license-crypto';
import type { OfflineLicensePayloadV1 } from '../offline-licenses/offline-license.types';
import type { PushOfflineOperationsDto } from './dto/push-offline-operations.dto';
import {
  OfflineOperationEnvelopeError,
  parseOfflineOperationEnvelope,
  type OfflineOperationEnvelopeV1,
  type OfflineOperationPushResult,
  type OfflineOperationResultStatus,
} from './offline-operation.contract';
import type { SyncJsonObject } from './offline-operation-canonical-json';
import { OfflineOperationRegistry } from './offline-operation.registry';
import {
  OfflineOperationRepository,
  type BeginOfflineOperationResult,
} from './offline-operation.repository';

interface ParsedBatchItem {
  index: number;
  envelope: OfflineOperationEnvelopeV1;
}

@Injectable()
export class OfflineOperationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly licenses: OfflineLicenseCryptoService,
    private readonly repository: OfflineOperationRepository,
    private readonly registry: OfflineOperationRegistry,
  ) {}

  async push(
    input: PushOfflineOperationsDto,
    principal: SyncAuthenticatedPrincipal,
    context: TenantTransactionContext,
  ): Promise<{ results: OfflineOperationPushResult[] }> {
    const results = new Array<OfflineOperationPushResult>(input.operations.length);
    const parsed: ParsedBatchItem[] = [];

    input.operations.forEach((value, index) => {
      try {
        parsed.push({ index, envelope: parseOfflineOperationEnvelope(value) });
      } catch (error) {
        results[index] = this.malformedResult(value, error);
      }
    });
    parsed.sort((left, right) => {
      const sequenceOrder =
        BigInt(left.envelope.localSequence) - BigInt(right.envelope.localSequence);
      if (sequenceOrder !== 0n) return sequenceOrder < 0n ? -1 : 1;
      return left.index - right.index;
    });

    for (const item of parsed) {
      results[item.index] = await this.process(item.envelope, principal, context);
    }
    return { results };
  }

  private async process(
    envelope: OfflineOperationEnvelopeV1,
    principal: SyncAuthenticatedPrincipal,
    context: TenantTransactionContext,
  ): Promise<OfflineOperationPushResult> {
    if (envelope.storeId !== context.storeId || envelope.deviceId !== context.deviceId) {
      return this.result(envelope.operationId, 'REJECTED', 'SYNC_CONTEXT_MISMATCH');
    }
    if (!this.registry.supports(envelope.operationType)) {
      return this.result(envelope.operationId, 'REJECTED', 'SYNC_OPERATION_NOT_ALLOWED');
    }

    let license: OfflineLicensePayloadV1;
    try {
      license = this.licenses.verify(envelope.signedLicense);
    } catch {
      return this.result(envelope.operationId, 'REJECTED', 'OFFLINE_LICENSE_INVALID');
    }
    if (!this.licenseBindingMatches(envelope, license)) {
      return this.result(envelope.operationId, 'REJECTED', 'OFFLINE_LICENSE_BINDING_INVALID');
    }

    return this.database.withOfflineOperationTransaction(
      context,
      { operationId: envelope.operationId, operationType: envelope.operationType },
      async (transaction) => {
        const beginning = await this.repository.begin(transaction, envelope);
        if (beginning.disposition !== 'authorized') {
          return this.beginResult(envelope.operationId, beginning);
        }

        await transaction.execute(sql.raw('savepoint s19_offline_domain'));
        try {
          const response = await this.registry.dispatch(envelope, principal, context);
          await transaction.execute(sql.raw('release savepoint s19_offline_domain'));
          const completed = await this.repository.finish(
            transaction,
            context.storeId,
            envelope.operationId,
            'applied',
            response,
          );
          return this.result(
            envelope.operationId,
            beginning.processedOperationPreexisted ? 'EXACT_REPLAY' : 'APPLIED',
            null,
            completed.responseBody,
          );
        } catch (error) {
          await transaction.execute(sql.raw('rollback to savepoint s19_offline_domain'));
          await transaction.execute(sql.raw('release savepoint s19_offline_domain'));
          const failure = this.domainFailure(error);
          if (!failure) throw error;
          await this.repository.finish(
            transaction,
            context.storeId,
            envelope.operationId,
            failure.disposition,
            failure.response,
          );
          return this.result(envelope.operationId, failure.status, failure.response.code);
        }
      },
    );
  }

  private licenseBindingMatches(
    envelope: OfflineOperationEnvelopeV1,
    license: OfflineLicensePayloadV1,
  ): boolean {
    return (
      license.licenseId === envelope.offlineLicenseId &&
      license.storeId === envelope.storeId &&
      license.deviceId === envelope.deviceId &&
      license.subscriptionId === envelope.subscriptionId &&
      license.subscriptionVersion === envelope.subscriptionVersion &&
      license.signingKeyId === envelope.signingKeyId &&
      envelope.trustedTimeEvidence.trustedServerTime === new Date(license.issuedAt).toISOString()
    );
  }

  private beginResult(
    operationId: string,
    beginning: BeginOfflineOperationResult,
  ): OfflineOperationPushResult {
    const statuses: Record<
      Exclude<BeginOfflineOperationResult['disposition'], 'authorized'>,
      OfflineOperationResultStatus
    > = {
      exact_replay: 'EXACT_REPLAY',
      rejected: 'REJECTED',
      dependency_pending: 'DEPENDENCY_PENDING',
      conflict: 'CONFLICT',
      quarantined: 'QUARANTINED',
    };
    return this.result(
      operationId,
      statuses[
        beginning.disposition as Exclude<BeginOfflineOperationResult['disposition'], 'authorized'>
      ],
      beginning.reasonCode,
      beginning.responseBody,
    );
  }

  private domainFailure(error: unknown): {
    status: 'REJECTED' | 'CONFLICT';
    disposition: 'rejected' | 'conflict';
    response: SyncJsonObject & { code: string };
  } | null {
    if (!(error instanceof HttpException)) return null;
    const raw = error.getResponse();
    const code =
      typeof raw === 'object' && 'code' in raw && typeof raw.code === 'string'
        ? raw.code
        : error.getStatus() === 409
          ? 'DOMAIN_CONFLICT'
          : 'DOMAIN_REJECTED';
    const conflict = error.getStatus() === 409;
    return {
      status: conflict ? 'CONFLICT' : 'REJECTED',
      disposition: conflict ? 'conflict' : 'rejected',
      response: {
        code,
        message: conflict
          ? 'Offline operation conflicts with server state.'
          : 'Offline operation was rejected.',
      },
    };
  }

  private malformedResult(value: unknown, error: unknown): OfflineOperationPushResult {
    const operationId =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'operationId' in value &&
      typeof value.operationId === 'string'
        ? value.operationId
        : null;
    return this.result(
      operationId,
      'REJECTED',
      error instanceof OfflineOperationEnvelopeError ? error.code : 'SYNC_ENVELOPE_INVALID',
    );
  }

  private result(
    operationId: string | null,
    status: OfflineOperationResultStatus,
    code: string | null,
    response: SyncJsonObject | null = null,
  ): OfflineOperationPushResult {
    return { operationId, status, code, response };
  }
}
