import { validate } from 'class-validator';

import { CreateMoneyAccountDto } from './create-money-account.dto';
import { MoneyAccountLifecycleDto } from './money-account-lifecycle.dto';

describe('Money Account write DTOs', () => {
  it('requires UUID identities and a string name for create', async () => {
    const valid = Object.assign(new CreateMoneyAccountDto(), {
      id: '84000000-0000-4000-8000-000000000001',
      operationId: '84000000-0000-4000-8000-000000000002',
      name: 'Bank Account',
    });
    const invalid = Object.assign(new CreateMoneyAccountDto(), {
      id: 'invalid',
      operationId: 4,
      name: null,
    });

    await expect(validate(valid)).resolves.toEqual([]);
    await expect(validate(invalid)).resolves.toHaveLength(3);
  });

  it('accepts only a UUID operation and positive bigint decimal version for lifecycle', async () => {
    const valid = Object.assign(new MoneyAccountLifecycleDto(), {
      operationId: '84000000-0000-4000-8000-000000000003',
      expectedVersion: '9007199254740993',
    });
    await expect(validate(valid)).resolves.toEqual([]);

    for (const expectedVersion of ['0', '01', '-1', '1.0', '', 1]) {
      const invalid = Object.assign(new MoneyAccountLifecycleDto(), {
        operationId: valid.operationId,
        expectedVersion,
      });
      await expect(validate(invalid)).resolves.not.toEqual([]);
    }
  });
});
