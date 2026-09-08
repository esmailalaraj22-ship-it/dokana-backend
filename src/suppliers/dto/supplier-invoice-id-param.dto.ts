import { IsUUID } from 'class-validator';

export class SupplierInvoiceIdParamDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  invoiceId!: string;
}
