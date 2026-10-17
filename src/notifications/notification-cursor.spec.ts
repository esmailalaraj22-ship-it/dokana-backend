import { randomUUID } from 'node:crypto';

import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  NOTIFICATION_CURSOR_MAX_ENCODED_LENGTH,
  notificationCursorScopeHash,
} from './notification-cursor';

describe('Notification cursor', () => {
  it('round-trips a bounded canonical cursor within its exact filter scope', () => {
    const scopeHash = notificationCursorScopeHash('active', false, 'customer_debt_amount');
    const anchor = {
      createdAt: new Date('2026-10-16T10:30:00.000Z'),
      id: randomUUID(),
    };
    const cursor = encodeNotificationCursor(anchor, scopeHash);

    expect(cursor.length).toBeLessThanOrEqual(NOTIFICATION_CURSOR_MAX_ENCODED_LENGTH);
    expect(decodeNotificationCursor(cursor, scopeHash)).toEqual(anchor);
  });

  it('rejects reuse under a different lifecycle, read state, or type scope', () => {
    const scopeHash = notificationCursorScopeHash('active', false, 'customer_debt_amount');
    const cursor = encodeNotificationCursor(
      { createdAt: new Date('2026-10-16T10:30:00.000Z'), id: randomUUID() },
      scopeHash,
    );

    for (const incompatibleScope of [
      notificationCursorScopeHash('resolved', false, 'customer_debt_amount'),
      notificationCursorScopeHash('active', true, 'customer_debt_amount'),
      notificationCursorScopeHash('active', false, 'supplier_due'),
    ]) {
      expect(() => decodeNotificationCursor(cursor, incompatibleScope)).toThrow(
        'Request validation failed.',
      );
    }
  });

  it.each(['=', 'e30=', 'a'.repeat(NOTIFICATION_CURSOR_MAX_ENCODED_LENGTH + 1)])(
    'rejects malformed, non-canonical, or over-bound input %#',
    (cursor) => {
      expect(() =>
        decodeNotificationCursor(cursor, notificationCursorScopeHash(null, null, null)),
      ).toThrow('Request validation failed.');
    },
  );
});
