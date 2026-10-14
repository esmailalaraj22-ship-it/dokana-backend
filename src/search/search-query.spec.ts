import {
  escapeSearchPrefix,
  GLOBAL_SEARCH_MAX_CODE_UNITS,
  prepareGlobalSearchScope,
  SearchQueryError,
} from './search-query';

describe('global Search query contract', () => {
  it('reuses approved entity normalization and recognizes exact safe values', () => {
    expect(prepareGlobalSearchScope('  \u0623\u064e\u062d\u0645\u062f  ')).toMatchObject({
      query: '\u0623\u064e\u062d\u0645\u062f',
      customerNamePrefix: '\u0627\u062d\u0645\u062f',
      supplierNamePrefix: '\u0627\u062d\u0645\u062f',
      productNamePrefix: '\u0627\u062d\u0645\u062f',
      moneyAccountNamePrefix: '\u0623\u064e\u062d\u0645\u062f',
    });
    expect(prepareGlobalSearchScope('+970 59 900 0202').canonicalPhone).toBe('+970599000202');
    expect(prepareGlobalSearchScope('9007199254740993').amountMinor).toBe('9007199254740993');
    expect(prepareGlobalSearchScope('2026-10-14').exactDate).toBe('2026-10-14');
    expect(prepareGlobalSearchScope('18DCBF0A-ACBE-48D6-88ED-CD1B078DDF41').exactUuid).toBe(
      '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
    );
  });

  it('keeps pattern characters literal', () => {
    expect(escapeSearchPrefix('oil%_\\case')).toBe('oil\\%\\_\\\\case');
  });

  it.each([
    '',
    ' \u00a0\u2003 ',
    '\u0640\u064b',
    'invalid\u0000text',
    '\ud800',
    'x'.repeat(GLOBAL_SEARCH_MAX_CODE_UNITS + 1),
  ])('rejects empty, malformed, or over-bound query %#', (query) => {
    expect(() => prepareGlobalSearchScope(query)).toThrow(SearchQueryError);
    try {
      prepareGlobalSearchScope(query);
    } catch (error) {
      expect(error).toMatchObject({ field: 'q', constraint: 'globalSearch' });
    }
  });
});
