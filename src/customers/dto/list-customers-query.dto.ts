import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import type { CustomerStatus } from '../customer-read.types';

export class ListCustomersQueryDto {
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: CustomerStatus;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  cursor?: string;
}
