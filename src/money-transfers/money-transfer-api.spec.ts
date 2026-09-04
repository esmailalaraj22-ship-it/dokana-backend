import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

import { CreateMoneyTransferDto } from './dto/create-money-transfer.dto';
import { MoneyTransferController } from './money-transfer.controller';

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: CreateMoneyTransferDto,
  data: undefined,
};

describe('Money Transfer API boundary', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  const valid = {
    operationId: '40000000-0000-4000-8000-000000000001',
    sourceAccountId: '40000000-0000-4000-8000-000000000002',
    destinationAccountId: '40000000-0000-4000-8000-000000000003',
    amountMinor: '100',
    occurredAt: '2026-02-01T08:00:00.000Z',
  };

  it('accepts only the frozen economic-intent fields', async () => {
    await expect(pipe.transform(valid, metadata)).resolves.toBeInstanceOf(CreateMoneyTransferDto);

    await expect(
      pipe.transform(
        {
          ...valid,
          storeId: '40000000-0000-4000-8000-000000000004',
          accountingPeriodId: '40000000-0000-4000-8000-000000000005',
          sourceDeltaMinor: '-100',
          destinationDeltaMinor: '100',
          transactionGroupId: '40000000-0000-4000-8000-000000000006',
          sourceMovementId: '40000000-0000-4000-8000-000000000007',
          status: 'posted',
        },
        metadata,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it.each(['0', '-100', '10.5', '+10'])(
    'rejects non-positive or non-exact public amount %s',
    async (amountMinor) => {
      await expect(pipe.transform({ ...valid, amountMinor }, metadata)).rejects.toMatchObject({
        response: { statusCode: 400 },
      });
    },
  );

  it('exposes one dedicated create command and no mutation/correction API', () => {
    expect(Object.getOwnPropertyNames(MoneyTransferController.prototype).sort()).toEqual([
      'constructor',
      'create',
    ]);
  });
});
