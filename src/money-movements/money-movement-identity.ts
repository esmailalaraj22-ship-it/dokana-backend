import { createHash } from 'node:crypto';

import { isUUID } from 'class-validator';

// Deterministic, offline-reproducible fact identity (D10-P9a of the Money Posting
// Contract v1). Each generated fact receives a UUIDv5 derived from the business command
// operationId and a frozen effect discriminator, so retries reproduce identical rows and
// the existing per-table UNIQUE(store_id, operation_id) constraint is satisfied.

export const S10_FACT_NAMESPACE = 'faafc598-0d3d-5010-a246-0c178972e337';

const POSTGRESQL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MoneyFactIdentityError extends Error {
  constructor(readonly field: string) {
    super('Money fact identity input is invalid.');
    this.name = 'MoneyFactIdentityError';
  }
}

export function canonicalizeCommandOperationId(operationId: string): string {
  if (!POSTGRESQL_UUID_PATTERN.test(operationId)) {
    throw new MoneyFactIdentityError('operationId');
  }
  return operationId.toLowerCase();
}

export function deriveMoneyFactId(commandOperationId: string, discriminator: string): string {
  return derive(commandOperationId, discriminator, 'id');
}

export function deriveMoneyFactOperationId(
  commandOperationId: string,
  discriminator: string,
): string {
  return derive(commandOperationId, discriminator, 'op');
}

// The transaction group is the canonical business command identity; it groups all facts
// produced by one command.
export function deriveTransactionGroupId(commandOperationId: string): string {
  return canonicalizeCommandOperationId(commandOperationId);
}

function derive(commandOperationId: string, discriminator: string, suffix: 'id' | 'op'): string {
  const canonicalOperationId = canonicalizeCommandOperationId(commandOperationId);
  if (typeof discriminator !== 'string' || discriminator.length === 0) {
    throw new MoneyFactIdentityError('discriminator');
  }
  return uuidV5(`${canonicalOperationId}|${discriminator}|${suffix}`, S10_FACT_NAMESPACE);
}

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  if (namespaceBytes.length !== 16) {
    throw new MoneyFactIdentityError('namespace');
  }

  const bytes = Buffer.from(
    createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest().subarray(0, 16),
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');
  const result = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
  // Defensive: the derived value must always be a canonical UUID.
  if (!isUUID(result)) {
    throw new MoneyFactIdentityError('derived');
  }
  return result;
}
