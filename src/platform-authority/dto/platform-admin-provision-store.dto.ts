import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class PlatformAdminProvisionSettingsDto {
  @IsInt()
  @Min(0)
  @Max(1439)
  dailyReportTimeMinutes!: number;

  @IsIn(['warn', 'block'])
  defaultCreditPolicy!: 'warn' | 'block';

  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MaxLength(19)
  @Matches(/^(0|[1-9]\d*)$/)
  defaultCreditLimitMinor!: string | null;

  @IsBoolean()
  allowNegativeStock!: boolean;

  @IsBoolean()
  lowStockAlertEnabled!: boolean;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  debtAgeAlertDays!: number;

  @IsBoolean()
  backupEnabled!: boolean;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  backupIntervalHours!: number;
}

export class PlatformAdminProvisionStoreDto {
  @IsUUID()
  operationId!: string;

  @IsUUID()
  ownerUserId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason!: string;

  @IsBoolean()
  activateSubscription!: boolean;

  @ValidateNested()
  @IsDefined()
  @Type(() => PlatformAdminProvisionSettingsDto)
  settings!: PlatformAdminProvisionSettingsDto;
}
