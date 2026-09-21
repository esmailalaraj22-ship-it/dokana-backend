import { IsUUID } from 'class-validator';

export class CustomerFinancialCorrectionParamDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  targetOperationId!: string;
}
