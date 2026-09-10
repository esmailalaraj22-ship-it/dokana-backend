import { IsUUID } from 'class-validator';

export class SupplierPaymentIdParamDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  paymentId!: string;
}
