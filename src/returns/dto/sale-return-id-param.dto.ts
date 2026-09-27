import { IsUUID } from 'class-validator';

export class SaleReturnIdParamDto {
  @IsUUID()
  returnId!: string;
}
