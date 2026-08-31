import { isUUID } from 'class-validator';

export function canonicalizeMoneyAccountId(value: string): string {
  if (!isUUID(value)) {
    throw new TypeError('Invalid Money Account ID.');
  }

  return value.toLowerCase();
}
