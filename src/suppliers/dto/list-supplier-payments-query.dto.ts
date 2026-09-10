import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { SUPPLIER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH } from '../supplier-payment-read-cursor';

function parseStrictSupplierPaymentLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    return value;
  }
  return Number(value);
}

export class ListSupplierPaymentsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictSupplierPaymentLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(SUPPLIER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;

  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @IsOptional()
  @IsUUID()
  openingPayableId?: string;
}
