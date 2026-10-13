import { IsObject } from 'class-validator';

export class RecoverOfflineOperationDto {
  @IsObject()
  operation!: Record<string, unknown>;
}
