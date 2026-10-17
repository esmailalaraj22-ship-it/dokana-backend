import { randomUUID } from 'node:crypto';

import {
  AUDIT_CURSOR_MAX_ENCODED_LENGTH,
  auditCursorScopeHash,
  decodeAuditCursor,
  encodeAuditCursor,
  type AuditCursorScope,
} from './audit-cursor';

const scope: AuditCursorScope = {
  storeId: 'a3100000-0000-4000-8000-000000000001',
  occurredFrom: new Date('2026-01-01T00:00:00.000Z'),
  occurredTo: new Date('2026-12-31T23:59:59.999Z'),
  actorUserId: 'a3100000-0000-4000-8000-000000000002',
  action: 'SALE_CREATED',
  entityType: 'sale',
  entityId: 'a3100000-0000-4000-8000-000000000003',
};

describe('Audit cursor', () => {
  it('round-trips a bounded canonical cursor within its Store and filter scope', () => {
    const scopeHash = auditCursorScopeHash(scope);
    const anchor = {
      occurredAt: new Date('2026-10-17T10:30:00.000Z'),
      eventId: randomUUID(),
    };
    const cursor = encodeAuditCursor(anchor, scopeHash);

    expect(cursor.length).toBeLessThanOrEqual(AUDIT_CURSOR_MAX_ENCODED_LENGTH);
    expect(decodeAuditCursor(cursor, scopeHash)).toEqual(anchor);
  });

  it('rejects cross-Store and cross-filter cursor reuse', () => {
    const cursor = encodeAuditCursor(
      { occurredAt: new Date('2026-10-17T10:30:00.000Z'), eventId: randomUUID() },
      auditCursorScopeHash(scope),
    );

    for (const incompatible of [
      { ...scope, storeId: randomUUID() },
      { ...scope, action: 'SALE_CORRECTED' as const },
      { ...scope, entityId: randomUUID() },
      { ...scope, occurredFrom: new Date('2026-02-01T00:00:00.000Z') },
    ]) {
      expect(() => decodeAuditCursor(cursor, auditCursorScopeHash(incompatible))).toThrow(
        'Request validation failed.',
      );
    }
  });

  it.each(['=', 'e30=', 'a'.repeat(AUDIT_CURSOR_MAX_ENCODED_LENGTH + 1)])(
    'rejects malformed, non-canonical, or over-bound input %#',
    (cursor) => {
      expect(() => decodeAuditCursor(cursor, auditCursorScopeHash(scope))).toThrow(
        'Request validation failed.',
      );
    },
  );
});
