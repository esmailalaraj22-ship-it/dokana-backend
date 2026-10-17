import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class NotificationIdParamDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  notificationId!: string;
}
