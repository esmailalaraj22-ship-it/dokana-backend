import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AttachmentIdParamDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  attachmentId!: string;
}
