import { IsUUID } from 'class-validator';

export class SaleIdParamDto {
  @IsUUID()
  saleId!: string;
}
