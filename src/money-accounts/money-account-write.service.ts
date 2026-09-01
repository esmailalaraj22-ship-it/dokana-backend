import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { CreateMoneyAccountDto } from './dto/create-money-account.dto';
import type { MoneyAccountLifecycleDto } from './dto/money-account-lifecycle.dto';
import { canonicalizeMoneyAccountId } from './money-account-identifiers';
import {
  canonicalizeMoneyAccountNameV1,
  MoneyAccountNameValidationError,
} from './money-account-normalization';
import { MoneyAccountWriteRepository } from './money-account-write.repository';
import type {
  MoneyAccountLifecycleAction,
  MoneyAccountMutationFailure,
  MoneyAccountMutationResponse,
  MoneyAccountMutationResult,
  PreparedMoneyAccountCreate,
  PreparedMoneyAccountLifecycle,
} from './money-account-write.types';

const maximumPostgreSqlBigint = 9_223_372_036_854_775_807n;
const positiveDecimalPattern = /^[1-9]\d*$/;
export const MONEY_ACCOUNT_WRITE_REQUEST_VERSION = 1;

type MoneyAccountWritePrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class MoneyAccountWriteService {
  constructor(private readonly repository: MoneyAccountWriteRepository) {}

  async create(
    principal: MoneyAccountWritePrincipal,
    context: TenantTransactionContext,
    dto: CreateMoneyAccountDto,
  ): Promise<MoneyAccountMutationResponse> {
    this.assertAuthorized(principal, context);

    let input: PreparedMoneyAccountCreate;
    try {
      const moneyAccountId = this.canonicalizeIdentifier(dto.id, 'id');
      const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
      const { name, normalizedName } = canonicalizeMoneyAccountNameV1(dto.name);
      input = {
        moneyAccountId,
        operationId,
        name,
        normalizedName,
        requestHash: this.hashRequest({
          v: MONEY_ACCOUNT_WRITE_REQUEST_VERSION,
          action: 'money_account.create',
          moneyAccountId,
          name,
          normalizedName,
        }),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.create(context, input));
  }

  archive(
    principal: MoneyAccountWritePrincipal,
    context: TenantTransactionContext,
    moneyAccountId: string,
    dto: MoneyAccountLifecycleDto,
  ): Promise<MoneyAccountMutationResponse> {
    return this.changeLifecycle(principal, context, moneyAccountId, dto, 'archive');
  }

  restore(
    principal: MoneyAccountWritePrincipal,
    context: TenantTransactionContext,
    moneyAccountId: string,
    dto: MoneyAccountLifecycleDto,
  ): Promise<MoneyAccountMutationResponse> {
    return this.changeLifecycle(principal, context, moneyAccountId, dto, 'restore');
  }

  private async changeLifecycle(
    principal: MoneyAccountWritePrincipal,
    context: TenantTransactionContext,
    moneyAccountId: string,
    dto: MoneyAccountLifecycleDto,
    action: MoneyAccountLifecycleAction,
  ): Promise<MoneyAccountMutationResponse> {
    this.assertAuthorized(principal, context);

    let input: PreparedMoneyAccountLifecycle;
    try {
      const canonicalMoneyAccountId = this.canonicalizeIdentifier(moneyAccountId, 'moneyAccountId');
      const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
      const expectedVersion = this.parseExpectedVersion(dto.expectedVersion);
      input = {
        moneyAccountId: canonicalMoneyAccountId,
        operationId,
        expectedVersion,
        action,
        requestHash: this.hashRequest({
          v: MONEY_ACCOUNT_WRITE_REQUEST_VERSION,
          action: `money_account.${action}`,
          moneyAccountId: canonicalMoneyAccountId,
          expectedVersion: expectedVersion.toString(),
        }),
      };
    } catch (error) {
      this.rethrowValidationError(error);
    }

    return this.unwrap(await this.repository.changeLifecycle(context, input));
  }

  private assertAuthorized(
    principal: MoneyAccountWritePrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'MONEY_ACCOUNT_WRITE_NOT_ALLOWED',
        message: 'Money Account writes are not allowed.',
      });
    }
  }

  private parseExpectedVersion(value: string): bigint {
    if (!positiveDecimalPattern.test(value)) {
      throw this.validationException('expectedVersion', 'positiveDecimalString');
    }
    const expectedVersion = BigInt(value);
    if (expectedVersion > maximumPostgreSqlBigint) {
      throw this.validationException('expectedVersion', 'maxPostgreSqlBigint');
    }
    return expectedVersion;
  }

  private canonicalizeIdentifier(value: string, field: string): string {
    try {
      return canonicalizeMoneyAccountId(value);
    } catch (error) {
      if (error instanceof TypeError) {
        throw this.validationException(field, 'isUuid');
      }
      throw error;
    }
  }

  private hashRequest(payload: object): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  private unwrap(result: MoneyAccountMutationResult): MoneyAccountMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: MoneyAccountMutationFailure): never {
    const payload = { code: error.code, message: error.message };
    if (error.statusCode === 404) {
      throw new NotFoundException(payload);
    }
    throw new ConflictException(payload);
  }

  private rethrowValidationError(error: unknown): never {
    if (error instanceof MoneyAccountNameValidationError) {
      throw this.validationException(error.field, error.code);
    }
    throw error;
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
