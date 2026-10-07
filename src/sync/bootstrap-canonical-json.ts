import { createHash } from 'node:crypto';

import type { BootstrapJsonValue } from './bootstrap.types';

export function canonicalBootstrapJson(value: BootstrapJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalBootstrapJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalBootstrapJson(value[key] ?? null)}`)
    .join(',')}}`;
}

export function bootstrapChecksum(value: BootstrapJsonValue): string {
  return createHash('sha256').update(canonicalBootstrapJson(value), 'utf8').digest('hex');
}
