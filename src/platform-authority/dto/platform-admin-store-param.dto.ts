import { IsUUID } from 'class-validator';

export class PlatformAdminStoreParamDto {
  @IsUUID()
  storeId!: string;
}
