import { IsISO8601, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class ReplaceOpeningBalanceDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(20)
  @Matches(/^-?[1-9]\d*$/)
  amountMinor!: string;

  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  occurredAt!: string;
}
