import { randomUUID } from 'node:crypto';

import {
  decodeReportCursor,
  encodeReportCursor,
  REPORT_CURSOR_MAX_ENCODED_LENGTH,
  reportCursorScopeHash,
} from './report-cursor';

describe('Report cursor', () => {
  it('round-trips a bounded cursor and binds it to the report filter scope', () => {
    const scopeHash = reportCursorScopeHash('sales', ['2026-01-01', '2026-01-31', 'all']);
    const cursor = encodeReportCursor({
      scopeHash,
      anchorId: randomUUID(),
      anchorType: null,
    });

    expect(cursor.length).toBeLessThanOrEqual(REPORT_CURSOR_MAX_ENCODED_LENGTH);
    const decoded = decodeReportCursor(cursor, scopeHash);
    expect(decoded).toMatchObject({ scopeHash, anchorType: null });
    expect(typeof decoded.anchorId).toBe('string');
    expect(() => decodeReportCursor(cursor, reportCursorScopeHash('sales', ['different']))).toThrow(
      'Report query is invalid.',
    );
  });

  it('preserves the extra deterministic source tie-breaker for mixed correction reports', () => {
    const scopeHash = reportCursorScopeHash('returns-corrections', ['all']);
    const anchorId = randomUUID();
    const cursor = encodeReportCursor({ scopeHash, anchorId, anchorType: 'sale_return' });

    expect(decodeReportCursor(cursor, scopeHash)).toEqual({
      scopeHash,
      anchorId,
      anchorType: 'sale_return',
    });
  });

  it('rejects non-canonical and oversized cursor input', () => {
    const scopeHash = reportCursorScopeHash('sales', []);
    expect(() => decodeReportCursor('=', scopeHash)).toThrow('Report query is invalid.');
    expect(() =>
      decodeReportCursor('a'.repeat(REPORT_CURSOR_MAX_ENCODED_LENGTH + 1), scopeHash),
    ).toThrow('Report query is invalid.');
  });
});
