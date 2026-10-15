import type { CanonicalDocumentField, CanonicalDocumentTable } from './document.types';

const integerPattern = /^-?\d+$/;

function groupedDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function splitSignedInteger(value: string): { sign: string; digits: string } {
  if (!integerPattern.test(value)) {
    throw new Error('Canonical numeric value is not an integer string.');
  }
  return value.startsWith('-')
    ? { sign: '-', digits: value.slice(1) }
    : { sign: '', digits: value };
}

export function formatMoneyMinor(value: string): string {
  const { sign, digits } = splitSignedInteger(value);
  const padded = digits.padStart(3, '0');
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  return `ILS ${sign}${groupedDigits(major)}.${minor}`;
}

export function formatQuantityMilli(value: string): string {
  const { sign, digits } = splitSignedInteger(value);
  const padded = digits.padStart(4, '0');
  const whole = padded.slice(0, -3);
  const fraction = padded.slice(-3);
  return `${sign}${groupedDigits(whole)}.${fraction}`;
}

export function humanizeDocumentKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function nullDisplay(key: string): string {
  return /(cost|value)minor$/i.test(key) ? 'Unknown' : 'None';
}

export function formatCanonicalDocumentValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return nullDisplay(key);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (/minor$/i.test(key) && integerPattern.test(value)) return formatMoneyMinor(value);
    if (/milli$/i.test(key) && integerPattern.test(value)) return formatQuantityMilli(value);
    return value;
  }
  return JSON.stringify(value);
}

export function objectFields(value: object, prefix = ''): CanonicalDocumentField[] {
  const fields: CanonicalDocumentField[] = [];
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    const qualifiedKey = prefix ? `${prefix} ${key}` : key;
    if (fieldValue !== null && typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
      fields.push(...objectFields(fieldValue, qualifiedKey));
      continue;
    }
    fields.push({
      label: humanizeDocumentKey(qualifiedKey),
      value: formatCanonicalDocumentValue(key, fieldValue),
    });
  }
  return fields;
}

export function objectRows(title: string, values: readonly object[]): CanonicalDocumentTable {
  if (values.length === 0) return { title, columns: [], rows: [] };
  const keys = Object.keys(values[0] ?? {});
  return {
    title,
    columns: keys.map(humanizeDocumentKey),
    rows: values.map((value) =>
      keys.map((key) => formatCanonicalDocumentValue(key, (value as Record<string, unknown>)[key])),
    ),
  };
}

export function safePdfFilename(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,119}\.pdf$/.test(normalized) || normalized.includes('..')) {
    throw new Error('PDF filename is not safe.');
  }
  return normalized;
}
