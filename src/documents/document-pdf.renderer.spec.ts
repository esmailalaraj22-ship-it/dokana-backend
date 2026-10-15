import { DocumentPdfRenderer } from './document-pdf.renderer';
import type { CanonicalPdfDocumentModel } from './document.types';

describe('DocumentPdfRenderer', () => {
  it('renders Arabic, special text, and bounded multi-page content as a valid PDF', async () => {
    const longArabicText = `فاتورة متجر - نص عربي آمن <script>alert(1)</script> & file:///secret ${'تفاصيل '.repeat(80)}`;
    const model: CanonicalPdfDocumentModel = {
      documentType: 'test-report',
      title: 'Canonical PDF اختبار',
      filename: 'test-report.pdf',
      storeName: 'متجر دوكانا Dokana',
      generatedAt: '2026-10-15T10:00:00.000Z',
      reference: 'REF-1',
      notices: ['More results are available.'],
      sections: [
        {
          title: 'Details',
          fields: [
            { label: 'Description', value: longArabicText },
            { label: 'Exact money', value: 'ILS 9,007,199,254,740,993.12' },
          ],
        },
      ],
      tables: [
        {
          title: 'Rows',
          columns: ['Name', 'Quantity', 'Amount'],
          rows: Array.from({ length: 90 }, (_, index) => [
            `صف ${String(index + 1)}`,
            `${String(index)}.125`,
            `ILS ${String(index)}.00`,
          ]),
        },
      ],
    };

    const pdf = await new DocumentPdfRenderer().render(model);

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(10_000);
    const pageCount = pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThanOrEqual(6);
  });
});
