import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { PRODUCT_CURSOR_MAX_ENCODED_LENGTH } from '../product-read-cursor';
import { PRODUCT_SEARCH_MAX_CODE_UNITS } from '../product-read-query';
import type { ProductStatus } from '../product-read.types';

function parseStrictProductLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    return value;
  }
  return Number(value);
}

export class ListProductsQueryDto {
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: ProductStatus;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_SEARCH_MAX_CODE_UNITS)
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictProductLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
