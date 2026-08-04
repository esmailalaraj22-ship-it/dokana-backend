import { randomUUID } from 'node:crypto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveRequestId(
  incomingValue: string | string[] | undefined,
  trustIncoming: boolean,
): string {
  const candidate = Array.isArray(incomingValue) ? incomingValue[0] : incomingValue;

  if (trustIncoming && candidate && uuidPattern.test(candidate)) {
    return candidate.toLowerCase();
  }

  return randomUUID();
}

export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}
