import { IsUUID } from 'class-validator';

export class SupplierIdParamDto {
  @IsUUID()
  supplierId!: string;
}
