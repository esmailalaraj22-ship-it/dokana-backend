import { IsUUID } from 'class-validator';

export class CustomerPaymentIdParamDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  paymentId!: string;
}
