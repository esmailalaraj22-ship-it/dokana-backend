import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateAppSettingsDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1439)
  dailyReportTimeMinutes?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['warn', 'block'])
  defaultCreditPolicy?: 'warn' | 'block';

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(19)
  @Matches(/^(0|[1-9]\d*)$/)
  defaultCreditLimitMinor?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  allowNegativeStock?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  lowStockAlertEnabled?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  debtAgeAlertDays?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  backupEnabled?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  backupIntervalHours?: number;
}
