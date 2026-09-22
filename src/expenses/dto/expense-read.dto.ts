import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { EXPENSE_CURSOR_MAX_ENCODED_LENGTH } from '../expense-read-cursor';

export class ExpenseIdParamDto {
  @IsUUID()
  expenseId!: string;
}

function parseStrictLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return value;
  return Number(value);
}

export class ListExpensesQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(EXPENSE_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
