import { IsUUID } from 'class-validator';

export class ProductIdParamDto {
  @IsUUID()
  productId!: string;
}
