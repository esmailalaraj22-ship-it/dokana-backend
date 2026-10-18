import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILENAME_BYTES,
  type AttachmentMediaType,
  type ValidatedAttachmentFile,
} from './attachment.types';

const extensions: Readonly<Record<AttachmentMediaType, ReadonlySet<string>>> = {
  'application/pdf': new Set(['.pdf']),
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
};

export function validateAttachmentFile(file: Express.Multer.File): ValidatedAttachmentFile {
  if (file.size > ATTACHMENT_MAX_BYTES || file.buffer.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: 'ATTACHMENT_FILE_TOO_LARGE',
      message: 'Attachment file exceeds the 10 MiB limit.',
    });
  }
  if (file.size < 1 || file.buffer.byteLength !== file.size) {
    invalidFile('file', 'attachmentFileSize');
  }

  const fileName = validateDisplayFilename(file.originalname);
  const actualMediaType = detectAttachmentMediaType(file.buffer);
  if (actualMediaType === null || file.mimetype !== actualMediaType) {
    invalidFile('file', 'attachmentMediaType');
  }
  if (!extensions[actualMediaType].has(extname(fileName).toLowerCase())) {
    invalidFile('file', 'attachmentFilenameExtension');
  }

  return {
    buffer: file.buffer,
    fileName,
    mediaType: actualMediaType,
    sizeBytes: file.size,
    checksumSha256: createHash('sha256').update(file.buffer).digest('hex'),
  };
}

export function validateDisplayFilename(value: string): string {
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    Buffer.byteLength(normalized, 'utf8') > ATTACHMENT_MAX_FILENAME_BYTES ||
    hasUnsafeFilenameCharacter(normalized)
  ) {
    invalidFile('file', 'attachmentFilename');
  }
  return normalized;
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character === '/' ||
      character === '\\'
    ) {
      return true;
    }
  }
  return false;
}

export function detectAttachmentMediaType(buffer: Buffer): AttachmentMediaType | null {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.subarray(buffer.length - 12, buffer.length - 8).equals(Buffer.from([0, 0, 0, 0])) &&
    buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii') === 'IEND'
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff &&
    buffer.at(-2) === 0xff &&
    buffer.at(-1) === 0xd9
  ) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 10 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-' &&
    buffer.subarray(Math.max(0, buffer.length - 1024)).includes(Buffer.from('%%EOF'))
  ) {
    return 'application/pdf';
  }
  return null;
}

function invalidFile(field: string, constraint: string): never {
  throw new BadRequestException({
    code: 'ATTACHMENT_FILE_INVALID',
    message: 'Attachment file validation failed.',
    details: [{ field, constraints: [constraint] }],
  });
}
