import { validateAttachmentFile, validateDisplayFilename } from './attachment-file-validation';
import { ATTACHMENT_MAX_BYTES } from './attachment.types';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

function upload(buffer: Buffer, originalname: string, mimetype: string): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    size: buffer.byteLength,
    destination: '',
    filename: '',
    path: '',
    buffer,
    stream: undefined as unknown as Express.Multer.File['stream'],
  };
}

function pdf(size?: number): Buffer {
  const prefix = Buffer.from('%PDF-1.7\n');
  const suffix = Buffer.from('\n%%EOF');
  const target = size ?? prefix.length + suffix.length;
  return Buffer.concat([prefix, Buffer.alloc(target - prefix.length - suffix.length, 32), suffix]);
}

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
}

function png(): Buffer {
  return Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
}

describe('attachment file validation', () => {
  it.each([
    ['document.pdf', 'application/pdf', pdf(), 'application/pdf'],
    ['photo.jpg', 'image/jpeg', jpeg(), 'image/jpeg'],
    ['image.png', 'image/png', png(), 'image/png'],
  ])('accepts valid bounded %s content', (name, declaredType, buffer, expectedType) => {
    expect(validateAttachmentFile(upload(buffer, name, declaredType))).toMatchObject({
      fileName: name,
      mediaType: expectedType,
      sizeBytes: buffer.byteLength,
    });
  });

  it('accepts a valid file exactly at the 10 MiB limit', () => {
    expect(
      validateAttachmentFile(upload(pdf(ATTACHMENT_MAX_BYTES), 'maximum.pdf', 'application/pdf'))
        .sizeBytes,
    ).toBe(ATTACHMENT_MAX_BYTES);
  });

  it.each([
    ['spoof.jpg', 'image/jpeg', Buffer.from('MZ executable')],
    ['mismatch.pdf', 'application/pdf', jpeg()],
    ['archive.zip', 'application/zip', Buffer.from('PK\u0003\u0004')],
    ['page.html', 'text/html', Buffer.from('<html></html>')],
    ['vector.svg', 'image/svg+xml', Buffer.from('<svg></svg>')],
    ['renamed.exe', 'application/pdf', pdf()],
  ])('rejects invalid or disallowed %s content', (name, declaredType, buffer) => {
    expect(() => validateAttachmentFile(upload(buffer, name, declaredType))).toThrow(
      BadRequestException,
    );
  });

  it('rejects oversized content and inconsistent parser metadata', () => {
    const oversized = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    expect(() => validateAttachmentFile(upload(oversized, 'large.pdf', 'application/pdf'))).toThrow(
      PayloadTooLargeException,
    );
    const inconsistent = upload(pdf(), 'document.pdf', 'application/pdf');
    inconsistent.size += 1;
    expect(() => validateAttachmentFile(inconsistent)).toThrow();
  });

  it.each([
    '../escape.pdf',
    '..\\escape.pdf',
    'line\r\nbreak.pdf',
    'control\u0000.pdf',
    `${'a'.repeat(256)}.pdf`,
  ])('rejects dangerous display filename %p', (name) => {
    expect(() => validateDisplayFilename(name)).toThrow();
  });
});
