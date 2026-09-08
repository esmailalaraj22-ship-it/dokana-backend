import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { SUPPLIER_INVOICE_CURSOR_MAX_ENCODED_LENGTH } from '../supplier-financial-read-cursor';

function parseStrictSupplierInvoiceLimit(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    return value;
  }
  return Number(value);
}

export class ListSupplierInvoicesQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictSupplierInvoiceLimit(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(SUPPLIER_INVOICE_CURSOR_MAX_ENCODED_LENGTH)
  cursor?: string;
}
