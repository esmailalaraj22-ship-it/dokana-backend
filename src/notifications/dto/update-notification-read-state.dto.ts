import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateNotificationReadStateDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  read!: boolean;
}
