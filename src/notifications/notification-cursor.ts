import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';

import type { NotificationType } from '../database/schema';
import type { NotificationLifecycle, NotificationListAnchor } from './notification.types';

const CURSOR_VERSION = 1;
export const NOTIFICATION_CURSOR_MAX_ENCODED_LENGTH = 768;
export const NOTIFICATION_CURSOR_MAX_DECODED_BYTES = 512;
const scopeHashPattern = /^[A-Za-z0-9_-]{43}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function invalidCursor(constraint = 'notificationCursor'): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
    details: [{ field: 'cursor', constraints: [constraint] }],
  });
}

export function notificationCursorScopeHash(
  lifecycle: NotificationLifecycle | null,
  read: boolean | null,
  type: NotificationType | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([CURSOR_VERSION, lifecycle, read, type]), 'utf8')
    .digest('base64url');
}

export function encodeNotificationCursor(
  anchor: NotificationListAnchor,
  scopeHash: string,
): string {
  if (!scopeHashPattern.test(scopeHash) || !isUUID(anchor.id)) {
    throw new TypeError('Notification cursor input is invalid.');
  }
  const serialized = JSON.stringify([
    CURSOR_VERSION,
    scopeHash,
    anchor.createdAt.toISOString(),
    anchor.id.toLowerCase(),
  ]);
  if (Buffer.byteLength(serialized, 'utf8') > NOTIFICATION_CURSOR_MAX_DECODED_BYTES) {
    throw new Error('Notification cursor payload exceeds its bound.');
  }
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (encoded.length > NOTIFICATION_CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Notification cursor exceeds its bound.');
  }
  return encoded;
}

export function decodeNotificationCursor(
  encoded: string,
  expectedScope: string,
): NotificationListAnchor {
  if (
    encoded.length === 0 ||
    encoded.length > NOTIFICATION_CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalidCursor();
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > NOTIFICATION_CURSOR_MAX_DECODED_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw invalidCursor();
  }

  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(decoded)) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== CURSOR_VERSION ||
    value[1] !== expectedScope ||
    typeof value[2] !== 'string' ||
    typeof value[3] !== 'string' ||
    !isUUID(value[3]) ||
    value[3] !== value[3].toLowerCase()
  ) {
    throw invalidCursor('notificationCursorScope');
  }
  const createdAt = new Date(value[2]);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== value[2]) {
    throw invalidCursor();
  }
  return { createdAt, id: value[3] };
}
