import { createRequire } from 'node:module';

import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import type {
  CanonicalDocumentField,
  CanonicalDocumentTable,
  CanonicalPdfDocumentModel,
} from './document.types';

const nodeRequire = createRequire(__filename);
const regularFont = nodeRequire.resolve(
  '@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf',
);
const boldFont = nodeRequire.resolve(
  '@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf',
);
const arabicPattern = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/;
const PAGE_MARGIN = 42;
const FOOTER_SPACE = 24;
const MAX_DOCUMENT_CHARACTERS = 2_000_000;

@Injectable()
export class DocumentPdfRenderer {
  render(model: CanonicalPdfDocumentModel): Promise<Buffer> {
    this.assertBounded(model);
    const document = new PDFDocument({
      size: 'A4',
      margins: {
        top: PAGE_MARGIN,
        right: PAGE_MARGIN,
        bottom: PAGE_MARGIN + FOOTER_SPACE,
        left: PAGE_MARGIN,
      },
      bufferPages: true,
      compress: true,
      info: {
        Title: model.title,
        Author: model.storeName,
        Subject: model.documentType,
        Creator: 'Dokana Backend',
      },
    });
    const chunks: Buffer[] = [];

    return new Promise<Buffer>((resolve, reject) => {
      document.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
      document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));

      try {
        document.registerFont('DokanaRegular', regularFont);
        document.registerFont('DokanaBold', boldFont);
        this.renderDocument(document, model);
        this.renderFooters(document, model);
        document.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error('PDF rendering failed.'));
      }
    });
  }

  private renderDocument(document: PDFKit.PDFDocument, model: CanonicalPdfDocumentModel): void {
    document.font('DokanaBold').fontSize(18).fillColor('#17212b');
    this.text(document, model.storeName, { align: this.alignment(model.storeName) });
    document.moveDown(0.15).fontSize(15);
    this.text(document, model.title, { align: this.alignment(model.title) });
    document.font('DokanaRegular').fontSize(8.5).fillColor('#52606d');
    this.text(document, `Generated: ${model.generatedAt}`);
    if (model.reference) this.text(document, `Reference: ${model.reference}`);
    document.moveDown(0.5);
    this.rule(document);

    for (const notice of model.notices) {
      this.ensureSpace(document, 34);
      const noticeY = document.y;
      document
        .roundedRect(PAGE_MARGIN, noticeY, this.contentWidth(document), 28, 3)
        .fill('#fff5d6');
      document.fillColor('#5f4300').font('DokanaBold').fontSize(9);
      this.text(document, notice, {
        x: PAGE_MARGIN + 7,
        y: noticeY + 7,
        width: this.contentWidth(document) - 14,
        align: this.alignment(notice),
      });
      document.y = noticeY + 28;
    }

    for (const section of model.sections)
      this.renderSection(document, section.title, section.fields);
    for (const table of model.tables) this.renderTable(document, table);
  }

  private renderSection(
    document: PDFKit.PDFDocument,
    title: string,
    fields: CanonicalDocumentField[],
  ): void {
    this.ensureSpace(document, 46);
    document.moveDown(0.6).font('DokanaBold').fontSize(11).fillColor('#17212b');
    this.text(document, title, { align: this.alignment(title) });
    this.rule(document, '#c7d0d9');
    if (fields.length === 0) {
      document.font('DokanaRegular').fontSize(9).fillColor('#52606d');
      this.text(document, 'No data');
      return;
    }
    for (const field of fields) this.renderField(document, field);
  }

  private renderField(document: PDFKit.PDFDocument, field: CanonicalDocumentField): void {
    const labelWidth = 150;
    const valueWidth = this.contentWidth(document) - labelWidth - 8;
    const labelHeight = document.font('DokanaBold').fontSize(8.5).heightOfString(field.label, {
      width: labelWidth,
    });
    const valueHeight = document.font('DokanaRegular').fontSize(8.5).heightOfString(field.value, {
      width: valueWidth,
    });
    const height = Math.max(15, labelHeight, valueHeight) + 5;
    if (height > this.usableHeight(document) / 2) {
      this.ensureSpace(document, 38);
      document.font('DokanaBold').fontSize(8.5).fillColor('#34404b');
      this.text(document, field.label, { align: this.alignment(field.label) });
      document.font('DokanaRegular').fillColor('#17212b');
      this.text(document, field.value, { align: this.alignment(field.value) });
      document.moveDown(0.25);
      return;
    }
    this.ensureSpace(document, height);
    const y = document.y;
    document.font('DokanaBold').fontSize(8.5).fillColor('#34404b');
    this.text(document, field.label, { x: PAGE_MARGIN, y, width: labelWidth });
    document.font('DokanaRegular').fillColor('#17212b');
    this.text(document, field.value, {
      x: PAGE_MARGIN + labelWidth + 8,
      y,
      width: valueWidth,
      align: this.alignment(field.value),
    });
    document.y = y + height;
  }

  private renderTable(document: PDFKit.PDFDocument, table: CanonicalDocumentTable): void {
    this.ensureSpace(document, 50);
    document.moveDown(0.8).font('DokanaBold').fontSize(11).fillColor('#17212b');
    this.text(document, table.title, { align: this.alignment(table.title) });
    this.rule(document, '#c7d0d9');
    if (table.rows.length === 0) {
      document.font('DokanaRegular').fontSize(9).fillColor('#52606d');
      this.text(document, 'No rows');
      return;
    }
    if (table.columns.length > 5) {
      table.rows.forEach((row, index) => this.renderDetailedRow(document, table, row, index));
      return;
    }
    this.renderGridHeader(document, table.columns);
    table.rows.forEach((row, index) => this.renderGridRow(document, table.columns, row, index));
  }

  private renderDetailedRow(
    document: PDFKit.PDFDocument,
    table: CanonicalDocumentTable,
    row: string[],
    index: number,
  ): void {
    this.ensureSpace(document, 30);
    document.font('DokanaBold').fontSize(9).fillColor('#235789');
    this.text(document, `Row ${String(index + 1)}`);
    table.columns.forEach((column, columnIndex) =>
      this.renderField(document, { label: column, value: row[columnIndex] ?? '' }),
    );
    document.moveDown(0.2);
  }

  private renderGridHeader(document: PDFKit.PDFDocument, columns: string[]): void {
    const width = this.contentWidth(document) / columns.length;
    this.ensureSpace(document, 28);
    const y = document.y;
    document.rect(PAGE_MARGIN, y, this.contentWidth(document), 24).fill('#e8eef4');
    columns.forEach((column, index) => {
      document.font('DokanaBold').fontSize(8).fillColor('#17212b');
      this.text(document, column, {
        x: PAGE_MARGIN + index * width + 4,
        y: y + 6,
        width: width - 8,
        align: this.alignment(column),
      });
    });
    document.y = y + 24;
  }

  private renderGridRow(
    document: PDFKit.PDFDocument,
    columns: string[],
    row: string[],
    index: number,
  ): void {
    const width = this.contentWidth(document) / columns.length;
    document.font('DokanaRegular').fontSize(8);
    const height =
      Math.max(14, ...row.map((value) => document.heightOfString(value, { width: width - 8 }))) + 8;
    if (height > 130) {
      this.renderDetailedRow(document, { title: '', columns, rows: [] }, row, index);
      return;
    }
    if (!this.hasSpace(document, height + 8)) {
      document.addPage();
      this.renderGridHeader(document, columns);
    }
    const y = document.y;
    if (index % 2 === 1)
      document.rect(PAGE_MARGIN, y, this.contentWidth(document), height).fill('#f7f9fb');
    row.forEach((value, columnIndex) => {
      document.font('DokanaRegular').fontSize(8).fillColor('#17212b');
      this.text(document, value, {
        x: PAGE_MARGIN + columnIndex * width + 4,
        y: y + 4,
        width: width - 8,
        align: this.alignment(value),
      });
    });
    document.y = y + height;
  }

  private text(
    document: PDFKit.PDFDocument,
    value: string,
    options: PDFKit.Mixins.TextOptions & { x?: number; y?: number } = {},
  ): void {
    const { x, y, ...textOptions } = options;
    if (x !== undefined && y !== undefined) document.text(value, x, y, textOptions);
    else document.text(value, textOptions);
  }

  private renderFooters(document: PDFKit.PDFDocument, model: CanonicalPdfDocumentModel): void {
    const range = document.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      document.switchToPage(index);
      const bottomMargin = document.page.margins.bottom;
      document.page.margins.bottom = 0;
      document.font('DokanaRegular').fontSize(7).fillColor('#6b7785');
      document.text(
        `${model.documentType}  |  Page ${String(index - range.start + 1)} of ${String(range.count)}`,
        PAGE_MARGIN,
        document.page.height - 26,
        { width: this.contentWidth(document), align: 'center', lineBreak: false },
      );
      document.page.margins.bottom = bottomMargin;
    }
  }

  private rule(document: PDFKit.PDFDocument, color = '#8fa0b2'): void {
    document
      .moveTo(PAGE_MARGIN, document.y + 2)
      .lineTo(document.page.width - PAGE_MARGIN, document.y + 2)
      .lineWidth(0.5)
      .strokeColor(color)
      .stroke();
    document.moveDown(0.5);
  }

  private alignment(value: string): 'left' | 'right' {
    return arabicPattern.test(value) ? 'right' : 'left';
  }

  private ensureSpace(document: PDFKit.PDFDocument, height: number): void {
    if (!this.hasSpace(document, height)) document.addPage();
  }

  private hasSpace(document: PDFKit.PDFDocument, height: number): boolean {
    return document.y + height <= document.page.height - document.page.margins.bottom;
  }

  private contentWidth(document: PDFKit.PDFDocument): number {
    return document.page.width - PAGE_MARGIN * 2;
  }

  private usableHeight(document: PDFKit.PDFDocument): number {
    return document.page.height - document.page.margins.top - document.page.margins.bottom;
  }

  private assertBounded(model: CanonicalPdfDocumentModel): void {
    const characters = JSON.stringify(model).length;
    if (characters > MAX_DOCUMENT_CHARACTERS) {
      throw new Error('Canonical PDF document exceeds the renderer safety bound.');
    }
  }
}
