import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { notificationTypes, type NotificationType } from '../../database/schema';
import type { NotificationLifecycle } from '../notification.types';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'resolved'] })
  @IsOptional()
  @IsIn(['active', 'resolved'])
  lifecycle?: NotificationLifecycle;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  read?: 'true' | 'false';

  @ApiPropertyOptional({ enum: notificationTypes })
  @IsOptional()
  @IsIn(notificationTypes)
  type?: NotificationType;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ type: String, maxLength: 768 })
  @IsOptional()
  @IsString()
  @MaxLength(768)
  cursor?: string;
}
