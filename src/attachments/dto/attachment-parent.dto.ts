import { Transform } from 'class-transformer';
import { IsIn, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { attachmentEntityTypes, type AttachmentEntityType } from '../attachment.types';

export class AttachmentParentDto {
  @ApiProperty({ enum: attachmentEntityTypes })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn(attachmentEntityTypes)
  entityType!: AttachmentEntityType;

  @ApiProperty({ type: String, format: 'uuid' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  entityId!: string;
}
