import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { SEARCH_CURSOR_MAX_ENCODED_LENGTH } from '../search-cursor';
import { GLOBAL_SEARCH_MAX_CODE_UNITS } from '../search-query';
import { SEARCH_RESULT_TYPES, type SearchResultType } from '../search.types';

function parseStrictSearchLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) return value;
  return Number(value);
}

export class GlobalSearchQueryDto {
  @IsString()
  @MaxLength(GLOBAL_SEARCH_MAX_CODE_UNITS)
  q!: string;

  @IsOptional()
  @IsIn(SEARCH_RESULT_TYPES)
  type?: SearchResultType;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictSearchLimit(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
