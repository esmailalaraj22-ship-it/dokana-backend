import { IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

export class UpdateProductUnitDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  unitName?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  unitCode?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(19)
  @Matches(/^(?:0|[1-9]\d*)$/)
  salePriceMinor?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(19)
  @Matches(/^(?:0|[1-9]\d*)$/)
  purchasePriceMinor?: string | null;
}
