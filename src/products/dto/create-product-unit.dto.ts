import { IsInt, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

export class CreateProductUnitDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  operationId!: string;

  @IsUUID()
  productId!: string;

  @IsString()
  unitName!: string;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  unitCode?: string | null;

  @IsInt()
  factorNum!: number;

  @IsInt()
  factorDen!: number;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(19)
  @Matches(/^(?:0|[1-9]\d*)$/)
  salePriceMinor?: string | null;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(19)
  @Matches(/^(?:0|[1-9]\d*)$/)
  purchasePriceMinor?: string | null;
}
