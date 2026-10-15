export interface CanonicalDocumentField {
  label: string;
  value: string;
}

export interface CanonicalDocumentSection {
  title: string;
  fields: CanonicalDocumentField[];
}

export interface CanonicalDocumentTable {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface CanonicalPdfDocumentModel {
  documentType: string;
  title: string;
  filename: string;
  storeName: string;
  generatedAt: string;
  reference: string | null;
  notices: string[];
  sections: CanonicalDocumentSection[];
  tables: CanonicalDocumentTable[];
}

export interface GeneratedPdfDocument {
  filename: string;
  contentType: 'application/pdf';
  buffer: Buffer;
  model: CanonicalPdfDocumentModel;
}
