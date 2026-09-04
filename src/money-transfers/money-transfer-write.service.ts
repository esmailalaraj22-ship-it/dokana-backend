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
import { canonicalizeMoneyAccountId } from '../money-accounts/money-account-identifiers';
import {
  MAX_MONEY_MINOR,
  MoneyAmountError,
  parseMoneyMinorString,
} from '../money-movements/money-amount';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { CreateMoneyTransferDto } from './dto/create-money-transfer.dto';
import { MoneyTransferPostingRepository } from './money-transfer-posting.repository';
import type {
  MoneyTransferCommandInput,
  MoneyTransferMutationFailure,
  MoneyTransferMutationResponse,
  MoneyTransferMutationResult,
} from './money-transfer.types';

const absoluteIsoInstantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export const MONEY_TRANSFER_REQUEST_VERSION = 1;

type MoneyTransferPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class MoneyTransferWriteService {
  constructor(
    private readonly repository: MoneyTransferPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async create(
    principal: MoneyTransferPrincipal,
    context: TenantTransactionContext,
    dto: CreateMoneyTransferDto,
  ): Promise<MoneyTransferMutationResponse> {
    this.assertAuthorized(principal, context);
    const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
    const sourceAccountId = this.canonicalizeIdentifier(dto.sourceAccountId, 'sourceAccountId');
    const destinationAccountId = this.canonicalizeIdentifier(
      dto.destinationAccountId,
      'destinationAccountId',
    );
    const amountMinor = this.parsePositiveAmount(dto.amountMinor);
    const occurredAt = this.parseOccurredAt(dto.occurredAt);
    const postingDate = this.operationalTime.resolve(occurredAt).businessDate;
    const input: MoneyTransferCommandInput = {
      operationId,
      sourceAccountId,
      destinationAccountId,
      amountMinor,
      occurredAt,
      postingDate,
      requestHash: this.hashRequest({
        v: MONEY_TRANSFER_REQUEST_VERSION,
        action: 'money_transfer.create',
        sourceAccountId,
        destinationAccountId,
        amountMinor: amountMinor.toString(),
        occurredAt: occurredAt.toISOString(),
      }),
    };
    return this.unwrap(await this.repository.post(context, input));
  }

  private assertAuthorized(
    principal: MoneyTransferPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'MONEY_TRANSFER_WRITE_NOT_ALLOWED',
        message: 'Money Transfer writes are not allowed.',
      });
    }
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

  private parsePositiveAmount(value: string): bigint {
    let amount: bigint;
    try {
      amount = parseMoneyMinorString(value, 'amountMinor');
    } catch (error) {
      if (error instanceof MoneyAmountError) {
        throw this.validationException('amountMinor', 'integerDecimalString');
      }
      throw error;
    }
    if (amount <= 0n) {
      throw this.validationException('amountMinor', 'positiveDecimalString');
    }
    if (amount > MAX_MONEY_MINOR) {
      throw this.validationException('amountMinor', 'maxPostgreSqlBigint');
    }
    return amount;
  }

  private parseOccurredAt(value: string): Date {
    if (!absoluteIsoInstantPattern.test(value)) {
      throw this.validationException('occurredAt', 'isoUtcInstant');
    }
    const occurredAt = new Date(value);
    if (!Number.isFinite(occurredAt.getTime())) {
      throw this.validationException('occurredAt', 'isoUtcInstant');
    }
    return occurredAt;
  }

  private hashRequest(payload: object): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  private unwrap(result: MoneyTransferMutationResult): MoneyTransferMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: MoneyTransferMutationFailure): never {
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
