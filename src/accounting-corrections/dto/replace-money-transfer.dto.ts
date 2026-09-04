import { IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class ReplaceMoneyTransferDto {
  @IsUUID()
  operationId!: string;

  // Optional for a Replacement. When omitted the server reuses the original Transfer's
  // source account; when supplied it becomes the replacement Transfer's source. The server
  // still derives the trusted Store, the source negative sign, and the posting identity.
  @IsOptional()
  @IsUUID()
  sourceAccountId?: string;

  @IsUUID()
  destinationAccountId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  amountMinor!: string;

  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  occurredAt!: string;
}
