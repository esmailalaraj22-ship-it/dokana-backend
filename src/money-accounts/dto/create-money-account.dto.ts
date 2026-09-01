import { IsString, IsUUID } from 'class-validator';

export class CreateMoneyAccountDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  operationId!: string;

  @IsString()
  name!: string;
}
