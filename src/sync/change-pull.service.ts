import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import { ChangePullRepository } from './change-pull.repository';
import type { ChangePullItem, ChangePullResponse, ChangePullRow } from './change-pull.types';
import type { PullChangesQueryDto } from './dto/pull-changes-query.dto';
import {
  InvalidSyncCursorError,
  LegacySyncCursorError,
  SyncCursorService,
} from './sync-cursor.service';

const defaultPageSize = 100;
const supportedStreamGeneration = 1;
const supportedChangeContractVersion = 1;
const supportedRepresentationVersion = 1;

function databaseError(error: unknown): { code?: string; message?: string } {
  let candidate: unknown = error;
  let message: string | undefined;
  for (
    let depth = 0;
    depth < 5 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    const record = candidate as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.message === 'string') message = record.message;
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        message,
      };
    }
    if (record.cause === candidate) break;
    candidate = record.cause;
  }
  return { message };
}

@Injectable()
export class ChangePullService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ChangePullRepository,
    private readonly cursors: SyncCursorService,
  ) {}

  async pull(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
    query: PullChangesQueryDto,
  ): Promise<ChangePullResponse> {
    this.assertContext(principal, context);
    let cursor;
    try {
      cursor = this.cursors.decode(query.cursor);
    } catch (error) {
      if (error instanceof LegacySyncCursorError) throw this.rebootstrapRequired();
      if (error instanceof InvalidSyncCursorError) throw this.invalidCursor();
      throw error;
    }
    if (cursor.storeId !== context.storeId) throw this.invalidCursor();
    const limit = query.limit ?? defaultPageSize;

    try {
      return await this.database.withTenantSnapshotTransaction(context, async (transaction) => {
        const bounds = await this.repository.readBounds(transaction, context.storeId);
        if (bounds.streamGeneration !== supportedStreamGeneration) {
          throw this.unavailable();
        }
        if (cursor.sequence < bounds.minimumReplayableSequence) {
          throw this.rebootstrapRequired();
        }
        if (cursor.sequence > bounds.headSequence) throw this.invalidCursor();

        const rows = await this.repository.readPage(
          transaction,
          context.storeId,
          cursor.sequence,
          limit,
        );
        this.assertPage(rows, cursor.sequence, bounds.headSequence, limit);
        const lastSequence = rows.at(-1)?.storeSequence ?? cursor.sequence;
        return {
          changeFeedVersion: 1,
          changes: rows.map((row) => this.mapChange(row)),
          nextCursor: this.cursors.issue(context.storeId, lastSequence),
          hasMore: lastSequence < bounds.headSequence,
        };
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof GoneException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      const postgres = databaseError(error);
      if (postgres.message === 'SYNC_REBOOTSTRAP_REQUIRED') throw this.rebootstrapRequired();
      if (postgres.message === 'SYNC_CURSOR_AHEAD' || postgres.code === '22023') {
        throw this.invalidCursor();
      }
      if (postgres.code === '42501') {
        throw new ForbiddenException({
          code: 'SYNC_PULL_NOT_ALLOWED',
          message: 'Synchronization pull is not allowed.',
        });
      }
      throw this.unavailable();
    }
  }

  private assertPage(
    rows: readonly ChangePullRow[],
    afterSequence: bigint,
    headSequence: bigint,
    limit: number,
  ): void {
    const remaining = headSequence - afterSequence;
    const expectedLength = remaining > BigInt(limit) ? limit : Number(remaining);
    if (rows.length !== expectedLength) throw this.unavailable();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (
        row?.storeSequence !== afterSequence + BigInt(index + 1) ||
        row.contractVersion !== supportedChangeContractVersion ||
        row.representationVersion !== supportedRepresentationVersion
      ) {
        throw this.unavailable();
      }
    }
  }

  private mapChange(row: ChangePullRow): ChangePullItem {
    return {
      sequence: row.storeSequence.toString(),
      eventId: row.eventId,
      changeContractVersion: 1,
      representationVersion: 1,
      entityType: row.entityType,
      entityKey: row.entityKey,
      entityId: row.entityId,
      action: row.action,
      entityVersion: row.entityVersion.toString(),
      operationId: row.operationId,
      deviceId: row.deviceId,
      representation: row.representation,
      occurredAt: row.occurredAt.toISOString(),
      capturedAt: row.capturedAt.toISOString(),
    };
  }

  private assertContext(
    principal: AuthenticatedPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SYNC_PULL_NOT_ALLOWED',
        message: 'Synchronization pull is not allowed.',
      });
    }
  }

  private invalidCursor(): BadRequestException {
    return new BadRequestException({
      code: 'SYNC_CURSOR_INVALID',
      message: 'Synchronization cursor is invalid.',
    });
  }

  private rebootstrapRequired(): GoneException {
    return new GoneException({
      code: 'SYNC_REBOOTSTRAP_REQUIRED',
      message: 'A new synchronization bootstrap is required.',
    });
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'SYNC_CHANGE_STREAM_UNAVAILABLE',
      message: 'The synchronization change stream is unavailable.',
    });
  }
}
