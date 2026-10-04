import { isUuid } from '../common/logging/request-id';

const cursorVersion = 1;
export const PLATFORM_ADMIN_CURSOR_MAX_LENGTH = 512;

type CursorKind = 'stores' | 'history';

interface CursorPayload {
  v: 1;
  kind: CursorKind;
  at: string;
  id: string;
  storeId: string | null;
}

export interface PlatformAdminCursorPosition {
  at: Date;
  id: string;
}

function invalidCursor(): TypeError {
  return new TypeError('Platform administration cursor is invalid.');
}

function parseDate(value: unknown): Date {
  if (typeof value !== 'string') throw invalidCursor();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw invalidCursor();
  return date;
}

function parsePayload(value: unknown, kind: CursorKind, storeId: string | null): CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidCursor();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'at,id,kind,storeId,v' ||
    record.v !== cursorVersion ||
    record.kind !== kind ||
    typeof record.id !== 'string' ||
    !isUuid(record.id) ||
    record.storeId !== storeId
  ) {
    throw invalidCursor();
  }
  parseDate(record.at);
  return record as unknown as CursorPayload;
}

export function encodePlatformAdminCursor(
  kind: CursorKind,
  position: PlatformAdminCursorPosition,
  storeId: string | null = null,
): string {
  const payload: CursorPayload = {
    v: cursorVersion,
    kind,
    at: position.at.toISOString(),
    id: position.id.toLowerCase(),
    storeId,
  };
  parsePayload(payload, kind, storeId);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > PLATFORM_ADMIN_CURSOR_MAX_LENGTH) throw invalidCursor();
  return encoded;
}

export function decodePlatformAdminCursor(
  encoded: string,
  kind: CursorKind,
  storeId: string | null = null,
): PlatformAdminCursorPosition {
  if (
    encoded.length === 0 ||
    encoded.length > PLATFORM_ADMIN_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalidCursor();
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) throw invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  const payload = parsePayload(parsed, kind, storeId);
  return { at: parseDate(payload.at), id: payload.id.toLowerCase() };
}
