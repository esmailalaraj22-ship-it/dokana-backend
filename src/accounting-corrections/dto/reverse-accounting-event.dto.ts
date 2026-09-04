import { IsISO8601, IsString, IsUUID, Matches } from 'class-validator';

export class ReverseAccountingEventDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  occurredAt!: string;
}
