import { IsUUID } from 'class-validator';

export class ProductUnitIdParamDto {
  @IsUUID()
  unitId!: string;
}
