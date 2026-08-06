import { IsEmail, IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import type { DevicePlatform } from '../auth.types';

export class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_024)
  password!: string;

  @IsUUID()
  storeId!: string;

  @IsUUID()
  deviceId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  deviceName!: string;

  @IsIn(['android', 'ios'])
  devicePlatform!: DevicePlatform;
}
