import {
  formatCanonicalDocumentValue,
  formatMoneyMinor,
  formatQuantityMilli,
  safePdfFilename,
} from './document-format';

describe('canonical document formatting', () => {
  it('formats signed bigint money without Number conversion', () => {
    expect(formatMoneyMinor('900719925474099312345')).toBe('ILS 9,007,199,254,740,993,123.45');
    expect(formatMoneyMinor('-7')).toBe('ILS -0.07');
    expect(formatMoneyMinor('0')).toBe('ILS 0.00');
  });

  it('formats exact signed milli-units', () => {
    expect(formatQuantityMilli('9007199254740993')).toBe('9,007,199,254,740.993');
    expect(formatQuantityMilli('-1250')).toBe('-1.250');
    expect(formatQuantityMilli('0')).toBe('0.000');
  });

  it('preserves unknown cost instead of representing it as zero', () => {
    expect(formatCanonicalDocumentValue('inventoryValueMinor', null)).toBe('Unknown');
    expect(formatCanonicalDocumentValue('customerName', null)).toBe('None');
  });

  it('accepts only fixed safe PDF filenames', () => {
    expect(safePdfFilename('Sale-123.pdf')).toBe('sale-123.pdf');
    expect(() => safePdfFilename('../sale.pdf')).toThrow('PDF filename is not safe.');
    expect(() => safePdfFilename('sale/123.pdf')).toThrow('PDF filename is not safe.');
    expect(() => safePdfFilename('sale\r\nheader.pdf')).toThrow('PDF filename is not safe.');
  });
});
