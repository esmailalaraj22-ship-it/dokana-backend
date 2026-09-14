import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { CUSTOMER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH } from '../customer-payment-read-cursor';

function parseStrictLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return value;
  return Number(value);
}

export class ListCustomerPaymentsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(CUSTOMER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
