import { IsBoolean, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

export class UpdateProductDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  sku?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  barcode?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  description?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isPinned?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(19)
  @Matches(/^(?:0|[1-9]\d*)$/)
  lowStockThresholdMilli?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsBoolean()
  allowNegativeStockOverride?: boolean | null;
}
