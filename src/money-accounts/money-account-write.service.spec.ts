import { createHash } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { CreateMoneyAccountDto } from './dto/create-money-account.dto';
import type { MoneyAccountWriteRepository } from './money-account-write.repository';
import {
  MONEY_ACCOUNT_WRITE_REQUEST_VERSION,
  MoneyAccountWriteService,
} from './money-account-write.service';
import type { MoneyAccountMutationResponse } from './money-account-write.types';

const context: TenantTransactionContext = {
  storeId: '84100000-0000-4000-8000-000000000001',
  userId: '84100000-0000-4000-8000-000000000002',
  deviceId: '84100000-0000-4000-8000-000000000003',
  requestId: '84100000-0000-4000-8000-000000000004',
};
const principal: Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
> = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
};
const createDto: CreateMoneyAccountDto = {
  id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  name: '  BANK   Account  ',
};
const response: MoneyAccountMutationResponse = {
  id: createDto.id.toLowerCase(),
  name: 'BANK Account',
  accountType: 'transfer',
  isDefault: false,
  status: 'active',
  archivedAt: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  version: '1',
  operationId: createDto.operationId.toLowerCase(),
};

describe('MoneyAccountWriteService', () => {
  const repository = {
    create: jest.fn(),
    changeLifecycle: jest.fn(),
  } as jest.Mocked<Pick<MoneyAccountWriteRepository, 'create' | 'changeLifecycle'>>;
  const service = new MoneyAccountWriteService(
    repository as unknown as MoneyAccountWriteRepository,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.create.mockResolvedValue({ ok: true, response });
    repository.changeLifecycle.mockResolvedValue({ ok: true, response });
  });

  it('preserves the client UUID and builds the exact normalized create fingerprint', async () => {
    await service.create(principal, context, createDto);

    const [createCall] = repository.create.mock.calls;
    if (!createCall) {
      throw new Error('Expected the repository create call.');
    }
    const input = createCall[1];
    expect(input).toMatchObject({
      moneyAccountId: createDto.id.toLowerCase(),
      operationId: createDto.operationId.toLowerCase(),
      name: 'BANK Account',
      normalizedName: 'bank account',
    });
    expect(input.requestHash).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            v: MONEY_ACCOUNT_WRITE_REQUEST_VERSION,
            action: 'money_account.create',
            moneyAccountId: createDto.id.toLowerCase(),
            name: 'BANK Account',
            normalizedName: 'bank account',
          }),
          'utf8',
        )
        .digest('hex'),
    );
  });

  it('canonicalizes lifecycle UUID/version and separates archive from restore fingerprints', async () => {
    const dto = {
      operationId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
      expectedVersion: '9007199254740993',
    };
    await service.archive(principal, context, createDto.id, dto);
    await service.restore(principal, context, createDto.id, dto);

    const [archiveCall, restoreCall] = repository.changeLifecycle.mock.calls;
    if (!archiveCall || !restoreCall) {
      throw new Error('Expected archive and restore repository calls.');
    }
    const archive = archiveCall[1];
    const restore = restoreCall[1];
    expect(archive).toMatchObject({
      moneyAccountId: createDto.id.toLowerCase(),
      operationId: dto.operationId.toLowerCase(),
      expectedVersion: 9_007_199_254_740_993n,
      action: 'archive',
    });
    expect(restore.action).toBe('restore');
    expect(archive.requestHash).not.toBe(restore.requestHash);
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects %s before repository access',
    async (membershipRole) => {
      await expect(
        service.create({ ...principal, membershipRole }, context, createDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.create).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects mismatched trusted %s before repository access',
    async (field) => {
      await expect(
        service.create(
          { ...principal, [field]: '84100000-0000-4000-8000-000000000099' },
          context,
          createDto,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.create).not.toHaveBeenCalled();
    },
  );
});
