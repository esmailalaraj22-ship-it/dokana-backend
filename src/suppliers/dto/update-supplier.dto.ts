import { IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

export class UpdateSupplierDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  phone?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  notes?: string | null;
}
