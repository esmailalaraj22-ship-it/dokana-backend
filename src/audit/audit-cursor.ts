import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';

import type { AuditBusinessAction, AuditBusinessEntityType, AuditListAnchor } from './audit.types';

const CURSOR_VERSION = 1;
export const AUDIT_CURSOR_MAX_ENCODED_LENGTH = 768;
export const AUDIT_CURSOR_MAX_DECODED_BYTES = 512;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface AuditCursorScope {
  storeId: string;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  actorUserId: string | null;
  action: AuditBusinessAction | null;
  entityType: AuditBusinessEntityType | null;
  entityId: string | null;
}

function invalidCursor(constraint = 'auditCursor'): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
    details: [{ field: 'cursor', constraints: [constraint] }],
  });
}

export function auditCursorScopeHash(scope: AuditCursorScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        CURSOR_VERSION,
        scope.storeId,
        scope.occurredFrom?.toISOString() ?? null,
        scope.occurredTo?.toISOString() ?? null,
        scope.actorUserId,
        scope.action,
        scope.entityType,
        scope.entityId,
      ]),
      'utf8',
    )
    .digest('base64url');
}

export function encodeAuditCursor(anchor: AuditListAnchor, scopeHash: string): string {
  if (!scopeHashPattern.test(scopeHash) || !isUUID(anchor.eventId)) {
    throw new TypeError('Audit cursor input is invalid.');
  }
  const serialized = JSON.stringify([
    CURSOR_VERSION,
    scopeHash,
    anchor.occurredAt.toISOString(),
    anchor.eventId.toLowerCase(),
  ]);
  if (Buffer.byteLength(serialized, 'utf8') > AUDIT_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Audit cursor payload exceeds its bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > AUDIT_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Audit cursor exceeds its bound.');
  }
  return encoded;
}

export function decodeAuditCursor(encoded: string, expectedScope: string): AuditListAnchor {
  if (
    encoded.length === 0 ||
    encoded.length > AUDIT_CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalidCursor();
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > AUDIT_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor();
  }

  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== CURSOR_VERSION ||
    value[1] !== expectedScope ||
    typeof value[2] !== 'string' ||
    typeof value[3] !== 'string' ||
    !isUUID(value[3]) ||
    value[3] !== value[3].toLowerCase()
  ) {
    throw invalidCursor('auditCursorScope');
  }
  const occurredAt = new Date(value[2]);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== value[2]) {
    throw invalidCursor();
  }
  return { occurredAt, eventId: value[3] };
}
