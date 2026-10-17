import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { TenantTransactionContext } from '../database/database.types';
import {
  auditBusinessActions,
  auditBusinessEntityTypes,
  type AuditBusinessAction,
  type AuditBusinessEntityType,
  type AuditBusinessRow,
  type AuditListCriteria,
  type AuditSafeContext,
  type AuditSafeJsonValue,
} from './audit.types';

interface AuditPhysicalRow extends Record<string, unknown> {
  eventId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityReference: string | null;
  actorType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  occurredAt: string;
  businessDate: string | null;
  safeContext: unknown;
}

const actionSet = new Set<string>(auditBusinessActions);
const entityTypeSet = new Set<string>(auditBusinessEntityTypes);

function isSafeJsonValue(value: unknown): value is AuditSafeJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => isSafeJsonValue(item));
  return typeof value === 'object' && Object.values(value).every((item) => isSafeJsonValue(item));
}

function isSafeContext(value: unknown): value is AuditSafeContext {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && isSafeJsonValue(value)
  );
}

@Injectable()
export class AuditRepository {
  constructor(private readonly database: DatabaseService) {}

  list(
    context: TenantTransactionContext,
    criteria: AuditListCriteria,
  ): Promise<AuditBusinessRow[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute<AuditPhysicalRow>(sql`
        select
          audit_event_id as "eventId",
          business_action as action,
          business_entity_type as "entityType",
          business_entity_id as "entityId",
          entity_reference as "entityReference",
          actor_type as "actorType",
          actor_user_id as "actorUserId",
          actor_display_name as "actorDisplayName",
          occurred_at as "occurredAt",
          business_date::text as "businessDate",
          safe_context as "safeContext"
        from ledger.read_owner_business_audit_v1(
          ${criteria.limit + 1}::integer,
          ${criteria.anchor?.occurredAt ?? null}::timestamptz,
          ${criteria.anchor?.eventId ?? null}::uuid,
          ${criteria.occurredFrom}::timestamptz,
          ${criteria.occurredTo}::timestamptz,
          ${criteria.actorUserId}::uuid,
          ${criteria.action}::text,
          ${criteria.entityType}::text,
          ${criteria.entityId}::uuid
        )
      `);

      return result.rows.map((row) => this.mapRow(row, context.storeId));
    });
  }

  private mapRow(row: AuditPhysicalRow, storeId: string): AuditBusinessRow {
    if (
      !actionSet.has(row.action) ||
      !entityTypeSet.has(row.entityType) ||
      (row.actorType !== 'user' && row.actorType !== 'system') ||
      !isSafeContext(row.safeContext)
    ) {
      throw new Error('The sanitized audit reader returned an invalid row.');
    }
    const occurredAt = new Date(row.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error('The sanitized audit reader returned an invalid timestamp.');
    }
    const entityId =
      row.entityType === 'store_settings' && row.entityId === null ? storeId : row.entityId;
    if (entityId === null) {
      throw new Error('The sanitized audit reader returned an invalid entity identifier.');
    }
    return {
      eventId: row.eventId,
      action: row.action as AuditBusinessAction,
      entityType: row.entityType as AuditBusinessEntityType,
      entityId,
      entityReference: row.entityReference,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorDisplayName: row.actorDisplayName,
      occurredAt,
      businessDate: row.businessDate,
      context: row.safeContext,
    };
  }
}
