import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CustomerLifecycleDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;
}
