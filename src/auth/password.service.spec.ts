import { needsRehash } from 'argon2';

import { ARGON2_MEMORY_COST_KIB, ARGON2_PARALLELISM, ARGON2_TIME_COST } from './auth.constants';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with Argon2id using the approved parameters', async () => {
    const encodedHash = await service.hash('correct horse battery staple');

    expect(encodedHash).toMatch(/^\$argon2id\$/);
    expect(
      needsRehash(encodedHash, {
        memoryCost: ARGON2_MEMORY_COST_KIB,
        timeCost: ARGON2_TIME_COST,
        parallelism: ARGON2_PARALLELISM,
      }),
    ).toBe(false);
    await expect(service.verify('correct horse battery staple', encodedHash)).resolves.toBe(true);
  });

  it('rejects an incorrect password and malformed stored hash', async () => {
    const encodedHash = await service.hash('expected-password');

    await expect(service.verify('incorrect-password', encodedHash)).resolves.toBe(false);
    await expect(service.verify('expected-password', 'not-an-argon2-hash')).resolves.toBe(false);
  });

  it('performs a dummy verification for an unknown identity', async () => {
    await expect(service.verify('untrusted-password', undefined)).resolves.toBe(false);
  });
});
