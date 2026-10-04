import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import type { SubscriptionLifecycleAction } from '../subscription-lifecycle.types';

export class PlatformAdminSubscriptionActionParamDto {
  @IsUUID()
  storeId!: string;

  @IsIn(['activate', 'extend', 'cancel', 'reactivate'])
  action!: SubscriptionLifecycleAction;
}

export class PlatformAdminSubscriptionMutationDto {
  @IsUUID()
  operationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason!: string;
}
