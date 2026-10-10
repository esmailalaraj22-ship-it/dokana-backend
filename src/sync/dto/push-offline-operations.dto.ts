import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject } from 'class-validator';

export const OFFLINE_PUSH_MAX_OPERATIONS = 50;

export class PushOfflineOperationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OFFLINE_PUSH_MAX_OPERATIONS)
  @IsObject({ each: true })
  operations!: Record<string, unknown>[];
}
