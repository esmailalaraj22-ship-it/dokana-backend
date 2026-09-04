import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

import { ReplaceMoneyTransferDto } from './dto/replace-money-transfer.dto';
import { ReplaceOpeningBalanceDto } from './dto/replace-opening-balance.dto';
import { ReplaceOwnerEventDto } from './dto/replace-owner-event.dto';
import { ReverseAccountingEventDto } from './dto/reverse-accounting-event.dto';
import { MoneyTransferCorrectionController } from './money-transfer-correction.controller';
import { OwnerAccountingCorrectionController } from './owner-accounting-correction.controller';

const metadata = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
  data: undefined,
});

describe('Accounting Correction API boundary', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  const common = {
    operationId: '40000000-0000-4000-8000-000000000001',
    occurredAt: '2026-02-01T08:00:00.000Z',
  };

  it('accepts only semantic reversal input', async () => {
    await expect(
      pipe.transform(common, metadata(ReverseAccountingEventDto)),
    ).resolves.toBeInstanceOf(ReverseAccountingEventDto);
    await expect(
      pipe.transform(
        {
          ...common,
          storeId: '40000000-0000-4000-8000-000000000002',
          accountingPeriodId: '40000000-0000-4000-8000-000000000003',
          amountDeltaMinor: '-100',
          movementType: 'correction',
          reversalOfId: '40000000-0000-4000-8000-000000000004',
        },
        metadata(ReverseAccountingEventDto),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('rejects zero replacement and an Opening account-change attempt', async () => {
    await expect(
      pipe.transform({ ...common, amountMinor: '0' }, metadata(ReplaceOpeningBalanceDto)),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
    await expect(
      pipe.transform(
        {
          ...common,
          amountMinor: '10',
          moneyAccountId: '40000000-0000-4000-8000-000000000002',
        },
        metadata(ReplaceOpeningBalanceDto),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('allows owner account replacement without exposing raw accounting fields', async () => {
    const valid = {
      ...common,
      moneyAccountId: '40000000-0000-4000-8000-000000000002',
      amountMinor: '10',
    };
    await expect(pipe.transform(valid, metadata(ReplaceOwnerEventDto))).resolves.toBeInstanceOf(
      ReplaceOwnerEventDto,
    );
    await expect(
      pipe.transform({ ...valid, ownerLiabilityDeltaMinor: '-10' }, metadata(ReplaceOwnerEventDto)),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('allows only destination replacement for a Transfer', async () => {
    const valid = {
      ...common,
      destinationAccountId: '40000000-0000-4000-8000-000000000002',
      amountMinor: '10',
    };
    await expect(pipe.transform(valid, metadata(ReplaceMoneyTransferDto))).resolves.toBeInstanceOf(
      ReplaceMoneyTransferDto,
    );
    await expect(
      pipe.transform(
        { ...valid, sourceAccountId: '40000000-0000-4000-8000-000000000003' },
        metadata(ReplaceMoneyTransferDto),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('exposes domain-oriented routes and no profit-withdrawal or raw-ledger method', () => {
    expect(Object.getOwnPropertyNames(MoneyTransferCorrectionController.prototype).sort()).toEqual([
      'constructor',
      'replace',
      'reverse',
    ]);
    expect(Object.getOwnPropertyNames(OwnerAccountingCorrectionController.prototype)).not.toContain(
      'replaceProfitWithdrawal',
    );
    expect(Object.getOwnPropertyNames(OwnerAccountingCorrectionController.prototype)).not.toContain(
      'postRawCorrection',
    );
  });
});
