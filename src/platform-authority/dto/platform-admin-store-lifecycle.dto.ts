import { IsIn, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

import type { StoreLifecycleAction } from '../platform-admin.types';

export class PlatformAdminStoreLifecycleParamDto {
  @IsUUID()
  storeId!: string;

  @IsIn(['suspend', 'restore'])
  action!: StoreLifecycleAction;
}

export class PlatformAdminStoreLifecycleDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason!: string;
}
