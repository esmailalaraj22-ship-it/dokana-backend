import { IsEmail, IsIn, IsString, MaxLength, MinLength, ValidateBy } from 'class-validator';

import { isUuid } from '../../common/logging/request-id';
import type { DevicePlatform } from '../auth.types';

// Login must accept the same identity UUIDs that the issued token can authenticate.
const identityUuidValidator = {
  name: 'isUuid',
  validator: { validate: (value: unknown) => typeof value === 'string' && isUuid(value) },
};

export class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_024)
  password!: string;

  @ValidateBy(identityUuidValidator)
  storeId!: string;

  @ValidateBy(identityUuidValidator)
  deviceId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  deviceName!: string;

  @IsIn(['android', 'ios'])
  devicePlatform!: DevicePlatform;
}
