import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { SUPPLIER_CURSOR_MAX_ENCODED_LENGTH } from '../supplier-read-cursor';
import { SUPPLIER_SEARCH_MAX_CODE_UNITS } from '../supplier-read-query';
import type { SupplierStatus } from '../supplier-read.types';

function parseStrictSupplierLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    return value;
  }
  return Number(value);
}

export class ListSuppliersQueryDto {
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: SupplierStatus;

  @IsOptional()
  @IsString()
  @MaxLength(SUPPLIER_SEARCH_MAX_CODE_UNITS)
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictSupplierLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(SUPPLIER_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
