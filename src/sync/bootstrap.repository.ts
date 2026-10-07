import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type {
  BootstrapBoundary,
  BootstrapDatasetDefinition,
  BootstrapRecord,
} from './bootstrap.types';

interface BoundaryRow {
  contractVersion: number;
  baseWatermark: bigint | string;
  snapshotId: string;
  serverTime: Date | string;
}

function requiredDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Bootstrap boundary returned invalid time.');
  return date;
}

function requiredRecord(value: unknown): BootstrapRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Bootstrap dataset returned an invalid record.');
  }
  return value as BootstrapRecord;
}

@Injectable()
export class BootstrapRepository {
  async readBoundary(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
  ): Promise<BootstrapBoundary> {
    const result = await transaction.execute(sql`
      select
        contract_version as "contractVersion",
        base_watermark as "baseWatermark",
        snapshot_id as "snapshotId",
        server_time as "serverTime"
      from sync.read_bootstrap_boundary_v1(
        ${context.storeId}::uuid,
        ${context.deviceId}::uuid
      )
    `);
    const row = result.rows[0] as BoundaryRow | undefined;
    if (row?.contractVersion !== 1 || !/^[0-9a-f]{64}$/.test(row.snapshotId)) {
      throw new Error('Bootstrap boundary returned no valid result.');
    }
    return {
      contractVersion: row.contractVersion,
      baseWatermark: row.baseWatermark.toString(),
      snapshotId: row.snapshotId,
      serverTime: requiredDate(row.serverTime),
    };
  }

  async readDatasetPage(
    transaction: DatabaseTransaction,
    context: TenantTransactionContext,
    dataset: BootstrapDatasetDefinition,
    offset: number,
    limit: number,
  ): Promise<BootstrapRecord[]> {
    const scope =
      dataset.scope === 'store-root'
        ? sql`source.id = ${context.storeId}::uuid`
        : dataset.scope === 'current-device'
          ? sql`source.store_id = ${context.storeId}::uuid
                and source.id = ${context.deviceId}::uuid`
          : sql`source.store_id = ${context.storeId}::uuid`;
    const result = await transaction.execute(sql`
      select sync.sanitize_bootstrap_record_v1(to_jsonb(source)) as record
      from ${sql.raw(dataset.relation)} as source
      where ${scope}
      order by ${sql.raw(dataset.orderBy)}
      limit ${limit}
      offset ${offset}
    `);

    const omittedFields = new Set(dataset.omittedFields ?? []);
    return result.rows.map((row) => {
      const record = requiredRecord((row as { record?: unknown }).record);
      const sanitized: BootstrapRecord = {};
      for (const [field, value] of Object.entries(record)) {
        if (!omittedFields.has(field)) sanitized[field] = value;
      }
      return sanitized;
    });
  }
}
