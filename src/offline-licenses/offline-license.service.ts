import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { isUuid } from '../common/logging/request-id';
import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import type { IssueOfflineLicenseDto } from './dto/issue-offline-license.dto';
import { OfflineLicenseCryptoService } from './offline-license-crypto';
import { OfflineLicenseRepository } from './offline-license.repository';
import type {
  OfflineLicenseDatabaseRecord,
  OfflineLicenseResponse,
  PreparedOfflineLicenseIssuance,
} from './offline-license.types';

const requestVersion = 1;

function databaseErrorCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

@Injectable()
export class OfflineLicenseService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OfflineLicenseRepository,
    private readonly crypto: OfflineLicenseCryptoService,
  ) {}

  async issue(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
    command: IssueOfflineLicenseDto,
  ): Promise<OfflineLicenseResponse> {
    this.assertAuthenticatedContext(principal, context);
    const operationId = command.operationId.toLowerCase();
    const input = this.prepare(context, operationId);

    try {
      const record = await this.database.withTenantTransaction(context, async (transaction) => {
        const prepared = await this.repository.prepare(transaction, context, input);
        if (!prepared.requiresSignature) return prepared;
        const signed = this.crypto.sign(prepared.signedPayload);
        return this.repository.complete(transaction, context, input, signed.signature);
      });
      return this.mapResponse(operationId, record);
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  private prepare(
    context: TenantTransactionContext,
    operationId: string,
  ): PreparedOfflineLicenseIssuance {
    const keyId = this.crypto.activeSigningKeyId;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: requestVersion,
          action: 'issue_offline_license',
          storeId: context.storeId,
          deviceId: context.deviceId,
        }),
        'utf8',
      )
      .digest('hex');
    return { licenseId: randomUUID(), operationId, requestHash, keyId };
  }

  private mapResponse(
    operationId: string,
    record: OfflineLicenseDatabaseRecord,
  ): OfflineLicenseResponse {
    const license = {
      algorithm: 'Ed25519' as const,
      payload: record.signedPayload,
      signature: record.signature,
    };
    this.crypto.verify(license);
    return {
      operationId,
      replayed: record.replayed,
      serverTime: record.signedPayload.issuedAt,
      subscriptionValidUntil: record.signedPayload.centralEntitlementEnd,
      nextOnlineVerificationRequiredAt: record.signedPayload.offlineValidUntil,
      license,
      verificationKey: this.crypto.verificationKey(record.keyId),
      trustedTime: {
        lastTrustedServerTime: record.signedPayload.issuedAt,
        offlineValidUntil: record.signedPayload.offlineValidUntil,
        expiryBoundary: 'exclusive',
        clockRollbackPolicy: 'read_only_and_online_revalidation_required',
      },
    };
  }

  private assertAuthenticatedContext(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      !isUuid(context.storeId) ||
      !isUuid(context.userId) ||
      !isUuid(context.deviceId) ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'OFFLINE_LICENSE_FORBIDDEN',
        message: 'Offline License verification is not allowed.',
      });
    }
  }

  private translateDatabaseError(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException
    ) {
      throw error;
    }
    const code = databaseErrorCode(error);
    if (code === '22023') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    if (code === '23505') {
      throw new ConflictException({
        code: 'OPERATION_ID_CONFLICT',
        message: 'The operation ID was already used for a different request.',
      });
    }
    if (code === '42501' || code === '55000') {
      throw new ForbiddenException({
        code: 'OFFLINE_LICENSE_NOT_AVAILABLE',
        message: 'Offline License verification is not available.',
      });
    }
    throw error;
  }
}
