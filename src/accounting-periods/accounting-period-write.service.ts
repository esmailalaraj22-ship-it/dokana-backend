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
import { canonicalizeAccountingPeriodId } from './accounting-period-identity';
import { AccountingPeriodWriteRepository } from './accounting-period-write.repository';
import type {
  AccountingPeriodMutationFailure,
  AccountingPeriodMutationResponse,
  AccountingPeriodMutationResult,
  PreparedAccountingPeriodClose,
} from './accounting-period-write.types';
import { ACCOUNTING_PERIOD_CLOSE_ACTION } from './accounting-period-write.types';
import type { AccountingPeriodCloseDto } from './dto/accounting-period-close.dto';

const maximumPostgreSqlBigint = 9_223_372_036_854_775_807n;
const positiveDecimalPattern = /^[1-9]\d*$/;
export const ACCOUNTING_PERIOD_CLOSE_REQUEST_VERSION = 1;

type AccountingPeriodWritePrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class AccountingPeriodWriteService {
  constructor(private readonly repository: AccountingPeriodWriteRepository) {}

  async close(
    principal: AccountingPeriodWritePrincipal,
    context: TenantTransactionContext,
    accountingPeriodId: string,
    dto: AccountingPeriodCloseDto,
  ): Promise<AccountingPeriodMutationResponse> {
    this.assertAuthorized(principal, context);

    const canonicalAccountingPeriodId = this.canonicalizeIdentifier(
      accountingPeriodId,
      'accountingPeriodId',
    );
    const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
    const expectedVersion = this.parseExpectedVersion(dto.expectedVersion);
    const input: PreparedAccountingPeriodClose = {
      accountingPeriodId: canonicalAccountingPeriodId,
      operationId,
      expectedVersion,
      action: ACCOUNTING_PERIOD_CLOSE_ACTION,
      requestHash: this.hashRequest({
        v: ACCOUNTING_PERIOD_CLOSE_REQUEST_VERSION,
        action: 'accounting_period.close',
        accountingPeriodId: canonicalAccountingPeriodId,
        expectedVersion: expectedVersion.toString(),
      }),
    };

    return this.unwrap(await this.repository.close(context, input));
  }

  private assertAuthorized(
    principal: AccountingPeriodWritePrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'ACCOUNTING_PERIOD_WRITE_NOT_ALLOWED',
        message: 'Accounting Period writes are not allowed.',
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
      return canonicalizeAccountingPeriodId(value);
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

  private unwrap(result: AccountingPeriodMutationResult): AccountingPeriodMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: AccountingPeriodMutationFailure): never {
    const payload = { code: error.code, message: error.message };
    if (error.statusCode === 404) {
      throw new NotFoundException(payload);
    }
    throw new ConflictException(payload);
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
