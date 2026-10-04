import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUuid } from '../common/logging/request-id';
import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import type {
  OfflineLicenseAdminListQueryDto,
  RevokeOfflineLicenseDto,
} from './dto/offline-license-admin.dto';
import { OfflineLicenseRepository } from './offline-license.repository';
import type { PreparedOfflineLicenseRevocation } from './offline-license.types';

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
export class OfflineLicenseAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OfflineLicenseRepository,
  ) {}

  async list(
    caller: TenantTransactionContext,
    storeIdInput: string,
    query: OfflineLicenseAdminListQueryDto,
  ): Promise<Record<string, unknown>> {
    const context = this.targetContext(caller, storeIdInput);
    try {
      const records = await this.database.withTenantTransaction(context, (transaction) =>
        this.repository.listAdmin(transaction, context.storeId, query.limit),
      );
      return {
        checkedAt: records[0]?.checkedAt.toISOString() ?? null,
        items: records.map((record) => ({
          licenseId: record.licenseId,
          deviceId: record.deviceId,
          subscriptionId: record.subscriptionId,
          signingKeyId: record.keyId,
          issuedAt: record.issuedAt.toISOString(),
          offlineValidUntil: record.expiresAt.toISOString(),
          revokedAt: record.revokedAt?.toISOString() ?? null,
          revokeReason: record.revokeReason,
          status: record.status,
        })),
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  async revoke(
    caller: TenantTransactionContext,
    storeIdInput: string,
    licenseIdInput: string,
    command: RevokeOfflineLicenseDto,
  ): Promise<Record<string, unknown>> {
    const context = this.targetContext(caller, storeIdInput);
    if (!isUuid(licenseIdInput)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    const licenseId = licenseIdInput.toLowerCase();
    const operationId = command.operationId.toLowerCase();
    const reason = command.reason.trim();
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          version: requestVersion,
          action: 'revoke_offline_license',
          storeId: context.storeId,
          licenseId,
          reason,
        }),
        'utf8',
      )
      .digest('hex');
    const input: PreparedOfflineLicenseRevocation = {
      licenseId,
      operationId,
      requestHash,
      reason,
    };

    try {
      const result = await this.database.withTenantTransaction(context, (transaction) =>
        this.repository.revoke(transaction, context.storeId, input),
      );
      return {
        licenseId: result.licenseId,
        revokedAt: result.revokedAt.toISOString(),
        revokeReason: result.revokeReason,
        replayed: result.replayed,
        operationId,
      };
    } catch (error) {
      this.translateDatabaseError(error);
    }
  }

  private targetContext(
    caller: TenantTransactionContext,
    storeIdInput: string,
  ): TenantTransactionContext {
    if (!isUuid(storeIdInput)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      });
    }
    return { ...caller, storeId: storeIdInput.toLowerCase() };
  }

  private translateDatabaseError(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      error instanceof NotFoundException
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
    if (code === 'P0002') {
      throw new NotFoundException({
        code: 'OFFLINE_LICENSE_NOT_FOUND',
        message: 'Offline License not found.',
      });
    }
    if (code === '42501') {
      throw new ForbiddenException({
        code: 'PLATFORM_ADMIN_FORBIDDEN',
        message: 'Platform administration operation is not allowed.',
      });
    }
    if (code === '55000') {
      throw new ConflictException({
        code: 'OFFLINE_LICENSE_STATE_CONFLICT',
        message: 'Offline License state conflicts with this operation.',
      });
    }
    throw error;
  }
}
