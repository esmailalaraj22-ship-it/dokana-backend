import { createHash } from 'node:crypto';

export type SyncJsonValue = null | boolean | number | string | SyncJsonValue[] | SyncJsonObject;
export interface SyncJsonObject {
  readonly [key: string]: SyncJsonValue;
}

export function canonicalSyncJson(value: SyncJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSyncJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(value[key] ?? null)}`)
    .join(',')}}`;
}

export function syncJsonHash(value: SyncJsonValue): string {
  return createHash('sha256').update(canonicalSyncJson(value), 'utf8').digest('hex');
}
