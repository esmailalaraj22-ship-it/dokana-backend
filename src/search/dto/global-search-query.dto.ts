import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SEARCH_CURSOR_MAX_ENCODED_LENGTH } from '../search-cursor';
import { GLOBAL_SEARCH_MAX_CODE_UNITS } from '../search-query';
import { SEARCH_RESULT_TYPES, type SearchResultType } from '../search.types';

function parseStrictSearchLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) return value;
  return Number(value);
}

export class GlobalSearchQueryDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: GLOBAL_SEARCH_MAX_CODE_UNITS,
    description:
      'Store-scoped search text. UUID, phone, SKU/barcode, exact minor-unit amount, exact date, and normalized text forms are supported by canonical search policy.',
  })
  @IsString()
  @MaxLength(GLOBAL_SEARCH_MAX_CODE_UNITS)
  q!: string;

  @ApiPropertyOptional({ enum: SEARCH_RESULT_TYPES })
  @IsOptional()
  @IsIn(SEARCH_RESULT_TYPES)
  type?: SearchResultType;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 50,
    default: 25,
    description: 'Maximum results in this bounded keyset page.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictSearchLimit(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    type: String,
    maxLength: SEARCH_CURSOR_MAX_ENCODED_LENGTH,
    description:
      'Opaque Store- and search-scope-bound continuation cursor. Reuse unchanged with identical q/type filters.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
