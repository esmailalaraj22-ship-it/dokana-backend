import { Type } from 'class-transformer';
import { IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class OfflineLicenseAdminStoreParamDto {
  @IsUUID()
  storeId!: string;
}

export class OfflineLicenseAdminParamDto extends OfflineLicenseAdminStoreParamDto {
  @IsUUID()
  licenseId!: string;
}

export class OfflineLicenseAdminListQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class RevokeOfflineLicenseDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason!: string;
}
