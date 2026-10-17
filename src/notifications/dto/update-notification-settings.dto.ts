import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNotificationSettingsDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  operationId!: string;

  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', maxLength: 19 })
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @ApiPropertyOptional({ type: String, pattern: '^(0|[1-9][0-9]*)$', maxLength: 19 })
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(/^(0|[1-9]\d*)$/)
  customerDebtAmountAlertMinor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 2_147_483_647 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  debtAgeAlertDays?: number;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  lowStockAlertEnabled?: boolean;
}
