import { ProductReadQueryError } from './product-read-query-error';
import {
  escapeProductNamePrefix,
  prepareProductSearchScope,
  PRODUCT_SEARCH_MAX_CODE_UNITS,
} from './product-read-query';

describe('Product read query contract', () => {
  it('distinguishes omitted search from an approved canonical search scope', () => {
    expect(prepareProductSearchScope(undefined)).toBeNull();
    expect(prepareProductSearchScope('  أحمــد  ')).toEqual({
      normalizedNamePrefix: 'احمد',
      canonicalSku: 'أحمــد',
      canonicalBarcode: 'أحمــد',
    });
  });

  it('preserves exact SKU case and opaque barcode leading zeroes', () => {
    expect(prepareProductSearchScope('  AbC-001  ')).toEqual({
      normalizedNamePrefix: 'abc-001',
      canonicalSku: 'AbC-001',
      canonicalBarcode: 'AbC-001',
    });
    expect(prepareProductSearchScope(' 001234 ')).toEqual({
      normalizedNamePrefix: '001234',
      canonicalSku: '001234',
      canonicalBarcode: '001234',
    });
  });

  it('escapes PostgreSQL pattern characters so prefix search remains literal', () => {
    expect(escapeProductNamePrefix('oil%_\\case')).toBe('oil\\%\\_\\\\case');
  });

  it.each([
    '',
    ' \u00a0\u2003 ',
    '\u0640\u064b',
    'invalid\u0000text',
    '\ud800',
    'x'.repeat(PRODUCT_SEARCH_MAX_CODE_UNITS + 1),
  ])('rejects supplied empty, malformed, or over-bound search %#', (search) => {
    expect(() => prepareProductSearchScope(search)).toThrow(ProductReadQueryError);
    try {
      prepareProductSearchScope(search);
    } catch (error) {
      expect(error).toMatchObject({ field: 'search', constraint: 'productSearch' });
    }
  });
});
