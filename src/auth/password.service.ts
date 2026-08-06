import { randomBytes } from 'node:crypto';

import {
  argon2id,
  hash as hashPassword,
  verify as verifyPasswordHash,
  type HashOptions,
} from 'argon2';
import { Injectable } from '@nestjs/common';

import {
  ARGON2_HASH_LENGTH,
  ARGON2_MEMORY_COST_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
} from './auth.constants';

const passwordHashOptions = {
  type: argon2id,
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
  hashLength: ARGON2_HASH_LENGTH,
  raw: false,
} as const satisfies HashOptions & { raw: false };

@Injectable()
export class PasswordService {
  private readonly dummyHash = hashPassword(
    randomBytes(32).toString('base64url'),
    passwordHashOptions,
  );

  async hash(password: string): Promise<string> {
    return hashPassword(password, passwordHashOptions);
  }

  async verify(password: string, encodedHash: string | undefined): Promise<boolean> {
    const comparisonHash = encodedHash ?? (await this.dummyHash);

    try {
      const matches = await verifyPasswordHash(comparisonHash, password);
      return encodedHash !== undefined && matches;
    } catch {
      return false;
    }
  }
}
