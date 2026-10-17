import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { auditBusinessActions, auditBusinessEntityTypes } from '../audit.types';

export class ListAuditQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  occurredFrom?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  occurredTo?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ enum: auditBusinessActions })
  @IsOptional()
  @IsIn(auditBusinessActions)
  action?: (typeof auditBusinessActions)[number];

  @ApiPropertyOptional({ enum: auditBusinessEntityTypes })
  @IsOptional()
  @IsIn(auditBusinessEntityTypes)
  entityType?: (typeof auditBusinessEntityTypes)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

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
