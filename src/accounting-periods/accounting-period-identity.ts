import { createHash } from 'node:crypto';

import { assertAccountingPeriodMonth } from './accounting-period-month';

export const ACCOUNTING_PERIOD_UUID_NAMESPACE = '2c9aa30a-c026-5003-93f8-8e2e921c76ff';

const POSTGRESQL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deriveAccountingPeriodId(
  storeId: string,
  periodYear: number,
  periodMonth: number,
): string {
  if (!POSTGRESQL_UUID_PATTERN.test(storeId)) {
    throw new TypeError('Accounting period identity requires a valid Store UUID.');
  }
  assertAccountingPeriodMonth(periodYear, periodMonth);

  const canonicalStoreId = storeId.toLowerCase();
  const canonicalMonth = `${periodYear.toString().padStart(4, '0')}-${periodMonth
    .toString()
    .padStart(2, '0')}`;
  const name = `${canonicalStoreId}:${canonicalMonth}`;

  return uuidV5(name, ACCOUNTING_PERIOD_UUID_NAMESPACE);
}

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  if (namespaceBytes.length !== 16) {
    throw new TypeError('Accounting period UUID namespace is invalid.');
  }

  const bytes = Buffer.from(
    createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest().subarray(0, 16),
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
