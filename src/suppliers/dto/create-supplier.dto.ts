import { IsString, IsUUID, ValidateIf } from 'class-validator';

export class CreateSupplierDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  operationId!: string;

  @IsString()
  name!: string;

  @IsString()
  phone!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  notes?: string | null;
}
