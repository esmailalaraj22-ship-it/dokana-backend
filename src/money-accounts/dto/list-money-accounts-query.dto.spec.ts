import { validate } from 'class-validator';

import { ListMoneyAccountsQueryDto } from './list-money-accounts-query.dto';
import { MoneyAccountIdParamDto } from './money-account-id-param.dto';

async function validateStatus(status: unknown): Promise<string[]> {
  const dto = new ListMoneyAccountsQueryDto();
  if (status !== undefined) {
    Object.assign(dto, { status });
  }
  const errors = await validate(dto);
  return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('Money Account read DTOs', () => {
  it('accepts only the optional active or archived list status', async () => {
    await expect(validateStatus(undefined)).resolves.toEqual([]);
    await expect(validateStatus('active')).resolves.toEqual([]);
    await expect(validateStatus('archived')).resolves.toEqual([]);
    await expect(validateStatus('all')).resolves.toContain('isIn');
    await expect(validateStatus('')).resolves.toContain('isIn');
    await expect(validateStatus(['active', 'archived'])).resolves.toContain('isIn');
  });

  it('uses the established UUID validator for the detail path', async () => {
    const valid = Object.assign(new MoneyAccountIdParamDto(), {
      moneyAccountId: '82000000-0000-4000-8000-000000000001',
    });
    const invalid = Object.assign(new MoneyAccountIdParamDto(), {
      moneyAccountId: 'not-a-uuid',
    });

    await expect(validate(valid)).resolves.toEqual([]);
    await expect(validate(invalid)).resolves.toHaveLength(1);
  });
});
