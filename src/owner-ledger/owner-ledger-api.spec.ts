import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

import { OpeningBalanceDto } from './dto/opening-balance.dto';
import { OwnerMoneyCommandDto } from './dto/owner-money-command.dto';
import { OwnerLedgerController } from './owner-ledger.controller';

const metadata = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
  data: undefined,
});

describe('Owner Ledger API boundary', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  it('accepts only the frozen opening intent fields', async () => {
    await expect(
      pipe.transform(
        {
          operationId: '40000000-0000-4000-8000-000000000001',
          moneyAccountId: '40000000-0000-4000-8000-000000000002',
          amountMinor: '-10',
          occurredAt: '2026-02-01T08:00:00.000Z',
        },
        metadata(OpeningBalanceDto),
      ),
    ).resolves.toBeInstanceOf(OpeningBalanceDto);

    await expect(
      pipe.transform(
        {
          operationId: '40000000-0000-4000-8000-000000000001',
          moneyAccountId: '40000000-0000-4000-8000-000000000002',
          amountMinor: '10',
          occurredAt: '2026-02-01T08:00:00.000Z',
          storeId: '40000000-0000-4000-8000-000000000003',
          accountingPeriodId: '40000000-0000-4000-8000-000000000004',
          signedDelta: '-10',
          entryType: 'profit_withdrawal',
          factId: '40000000-0000-4000-8000-000000000005',
        },
        metadata(OpeningBalanceDto),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('rejects signed, zero, and non-instant owner command inputs at the DTO boundary', async () => {
    for (const amountMinor of ['0', '-1']) {
      await expect(
        pipe.transform(
          {
            operationId: '40000000-0000-4000-8000-000000000001',
            moneyAccountId: '40000000-0000-4000-8000-000000000002',
            amountMinor,
            occurredAt: '2026-02-01T08:00:00.000Z',
          },
          metadata(OwnerMoneyCommandDto),
        ),
      ).rejects.toMatchObject({ response: { statusCode: 400 } });
    }
    await expect(
      pipe.transform(
        {
          operationId: '40000000-0000-4000-8000-000000000001',
          moneyAccountId: '40000000-0000-4000-8000-000000000002',
          amountMinor: '1',
          occurredAt: '2026-02-01',
        },
        metadata(OwnerMoneyCommandDto),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('exposes only dedicated S10.3 workflows and no profit-withdrawal command', () => {
    expect(Object.getOwnPropertyNames(OwnerLedgerController.prototype).sort()).toEqual([
      'constructor',
      'postCapitalWithdrawal',
      'postContribution',
      'postLoan',
      'postOpeningBalance',
      'postPersonalWithdrawal',
      'postReimbursement',
      'readPosition',
    ]);
  });
});
