import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PRODUCT_MEASUREMENT_TYPES, type ProductMeasurementType } from '../product-validation';

export class InitialBaseUnitDto {
  @IsUUID()
  id!: string;

  @IsString()
  unitName!: string;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  unitCode?: string | null;

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

export class CreateProductDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  operationId!: string;

  @IsString()
  name!: string;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  sku?: string | null;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  barcode?: string | null;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  description?: string | null;

  @IsIn(PRODUCT_MEASUREMENT_TYPES)
  measurementType!: ProductMeasurementType;

  @IsBoolean()
  trackInventory!: boolean;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsBoolean()
  allowNegativeStockOverride?: boolean | null;

  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(19)
  @Matches(/^(?:0|[1-9]\d*)$/)
  lowStockThresholdMilli?: string | null;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsObject()
  @ValidateNested()
  @Type(() => InitialBaseUnitDto)
  initialBaseUnit!: InitialBaseUnitDto;
}
