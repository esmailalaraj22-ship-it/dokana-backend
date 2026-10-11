import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.types';
import type { ChangePullBounds, ChangePullRow } from './change-pull.types';

interface BoundsRow {
  streamGeneration: number;
  headSequence: bigint | string;
  minimumReplayableSequence: bigint | string;
}

function requiredDate(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error('The change stream returned invalid time.');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('The change stream returned invalid time.');
  return date;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('The change stream returned an invalid string.');
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function requiredSmallInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('The change stream returned an invalid version.');
  }
  return value;
}

function requiredBigInteger(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new Error('The change stream returned an invalid integer.');
  }
  return BigInt(value);
}

function requiredRepresentation(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The change stream returned an invalid representation.');
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class ChangePullRepository {
  async readBounds(transaction: DatabaseTransaction, storeId: string): Promise<ChangePullBounds> {
    const result = await transaction.execute(sql`
      select
        stream_generation as "streamGeneration",
        head_sequence as "headSequence",
        minimum_replayable_sequence as "minimumReplayableSequence"
      from sync.read_store_change_bounds_v1(${storeId}::uuid)
    `);
    const row = result.rows[0] as BoundsRow | undefined;
    if (!row) throw new Error('The change stream returned no bounds.');
    return {
      streamGeneration: row.streamGeneration,
      headSequence: BigInt(row.headSequence),
      minimumReplayableSequence: BigInt(row.minimumReplayableSequence),
    };
  }

  async readPage(
    transaction: DatabaseTransaction,
    storeId: string,
    afterSequence: bigint,
    limit: number,
  ): Promise<ChangePullRow[]> {
    const result = await transaction.execute(sql`
      select
        store_sequence as "storeSequence",
        event_id as "eventId",
        contract_version as "contractVersion",
        representation_version as "representationVersion",
        entity_type as "entityType",
        entity_key as "entityKey",
        entity_id as "entityId",
        action,
        entity_version as "entityVersion",
        operation_id as "operationId",
        device_id as "deviceId",
        representation,
        occurred_at as "occurredAt",
        captured_at as "capturedAt"
      from sync.read_store_change_page_v2(
        ${storeId}::uuid,
        ${afterSequence.toString()}::bigint,
        ${limit}::integer
      )
    `);

    return result.rows.map((row) => ({
      storeSequence: requiredBigInteger(row.storeSequence),
      eventId: requiredString(row.eventId),
      contractVersion: requiredSmallInteger(row.contractVersion),
      representationVersion: requiredSmallInteger(row.representationVersion),
      entityType: requiredString(row.entityType),
      entityKey: requiredString(row.entityKey),
      entityId: nullableString(row.entityId),
      action: requiredString(row.action),
      entityVersion: requiredBigInteger(row.entityVersion),
      operationId: nullableString(row.operationId),
      deviceId: nullableString(row.deviceId),
      representation: requiredRepresentation(row.representation),
      occurredAt: requiredDate(row.occurredAt),
      capturedAt: requiredDate(row.capturedAt),
    }));
  }
}
