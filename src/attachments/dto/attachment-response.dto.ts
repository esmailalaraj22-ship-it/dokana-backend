import { ApiProperty } from '@nestjs/swagger';

import { attachmentEntityTypes, attachmentMediaTypes } from '../attachment.types';

export class AttachmentMetadataResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: attachmentEntityTypes })
  entityType!: (typeof attachmentEntityTypes)[number];

  @ApiProperty({ type: String, format: 'uuid' })
  entityId!: string;

  @ApiProperty({ type: String, maxLength: 255 })
  originalFilename!: string;

  @ApiProperty({ enum: attachmentMediaTypes })
  mediaType!: (typeof attachmentMediaTypes)[number];

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$' })
  sizeBytes!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class AttachmentListResponseDto {
  @ApiProperty({ type: [AttachmentMetadataResponseDto], maxItems: 10 })
  items!: AttachmentMetadataResponseDto[];
}
