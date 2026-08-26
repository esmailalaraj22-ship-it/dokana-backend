import { SupplierReadQueryError } from './supplier-read-query-error';
import {
  escapeSupplierNamePrefix,
  prepareSupplierSearchScope,
  SUPPLIER_SEARCH_MAX_CODE_UNITS,
} from './supplier-read-query';

describe('Supplier read query contract', () => {
  it('distinguishes omitted search from normalized name-only search', () => {
    expect(prepareSupplierSearchScope(undefined)).toBeNull();
    expect(
      prepareSupplierSearchScope('  AHMAD   \u0623\u064e\u062d\u0645\u0640\u0640\u062f  '),
    ).toEqual({
      normalizedNamePrefix: 'ahmad \u0627\u062d\u0645\u062f',
      canonicalPhone: null,
    });
  });

  it('adds only a complete canonical phone to the search scope', () => {
    expect(prepareSupplierSearchScope(' +970 599 123 456 ')).toEqual({
      normalizedNamePrefix: '+970 599 123 456',
      canonicalPhone: '+970599123456',
    });
    expect(prepareSupplierSearchScope('+972 50 234 5678')).toEqual({
      normalizedNamePrefix: '+972 50 234 5678',
      canonicalPhone: '+972502345678',
    });
    expect(prepareSupplierSearchScope('0599 123 456')?.canonicalPhone).toBe('+970599123456');
    expect(
      prepareSupplierSearchScope('\u0660\u0665\u0669\u0669 \u0661\u0662\u0663 \u0664\u0665\u0666')
        ?.canonicalPhone,
    ).toBe('+970599123456');
    expect(prepareSupplierSearchScope('0599')).toEqual({
      normalizedNamePrefix: '0599',
      canonicalPhone: null,
    });
  });

  it('escapes PostgreSQL pattern characters so name-prefix search remains literal', () => {
    expect(escapeSupplierNamePrefix('supply%_\\case')).toBe('supply\\%\\_\\\\case');
  });

  it.each([
    '',
    ' \u00a0\u2003 ',
    '\u0640\u064b',
    'invalid\u0000text',
    '\ud800',
    'x'.repeat(SUPPLIER_SEARCH_MAX_CODE_UNITS + 1),
  ])('rejects supplied empty, malformed, or over-bound search %#', (search) => {
    expect(() => prepareSupplierSearchScope(search)).toThrow(SupplierReadQueryError);
    try {
      prepareSupplierSearchScope(search);
    } catch (error) {
      expect(error).toMatchObject({ field: 'search', constraint: 'supplierSearch' });
    }
  });
});
