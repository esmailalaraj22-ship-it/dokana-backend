import { isUUID } from 'class-validator';

export function isCustomerId(value: string): boolean {
  return isUUID(value);
}

export function isCustomerOperationId(value: string): boolean {
  return isUUID(value);
}

export function canonicalizeCustomerId(value: string): string {
  if (!isCustomerId(value)) {
    throw new TypeError('Invalid Customer ID.');
  }
  return value.toLowerCase();
}

export function canonicalizeCustomerOperationId(value: string): string {
  if (!isCustomerOperationId(value)) {
    throw new TypeError('Invalid Customer operation ID.');
  }
  return value.toLowerCase();
}
