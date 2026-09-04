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
  MIN_MONEY_MINOR,
  MoneyAmountError,
  parseMoneyMinorString,
} from '../money-movements/money-amount';
import { OperationalTimeService } from '../settings/operational-time.service';
import { AccountingCorrectionPostingRepository } from './accounting-correction-posting.repository';
import type { ReplaceMoneyTransferDto } from './dto/replace-money-transfer.dto';
import type { ReplaceOpeningBalanceDto } from './dto/replace-opening-balance.dto';
import type { ReplaceOwnerEventDto } from './dto/replace-owner-event.dto';
import type { ReverseAccountingEventDto } from './dto/reverse-accounting-event.dto';
import type {
  AccountingCorrectionCommandInput,
  AccountingCorrectionDomain,
  AccountingCorrectionFailure,
  AccountingCorrectionMutationResponse,
  AccountingCorrectionMutationResult,
  AccountingCorrectionReplacement,
} from './accounting-correction.types';

const absoluteIsoInstantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export const ACCOUNTING_CORRECTION_REQUEST_VERSION = 1;

type AccountingCorrectionPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class AccountingCorrectionWriteService {
  constructor(
    private readonly repository: AccountingCorrectionPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  reverse(
    principal: AccountingCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationIdValue: string,
    domain: AccountingCorrectionDomain,
    dto: ReverseAccountingEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.submit(principal, context, targetOperationIdValue, domain, dto, undefined);
  }

  replaceOpeningBalance(
    principal: AccountingCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationIdValue: string,
    dto: ReplaceOpeningBalanceDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.submit(principal, context, targetOperationIdValue, 'opening_balance', dto, {
      amountMinor: this.parseOpeningReplacementAmount(dto.amountMinor),
    });
  }

  replaceOwnerEvent(
    principal: AccountingCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationIdValue: string,
    domain: Exclude<AccountingCorrectionDomain, 'opening_balance' | 'internal_transfer'>,
    dto: ReplaceOwnerEventDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.submit(principal, context, targetOperationIdValue, domain, dto, {
      amountMinor: this.parsePositiveAmount(dto.amountMinor),
      moneyAccountId: this.canonicalizeIdentifier(dto.moneyAccountId, 'moneyAccountId'),
    });
  }

  replaceTransfer(
    principal: AccountingCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationIdValue: string,
    dto: ReplaceMoneyTransferDto,
  ): Promise<AccountingCorrectionMutationResponse> {
    return this.submit(principal, context, targetOperationIdValue, 'internal_transfer', dto, {
      amountMinor: this.parsePositiveAmount(dto.amountMinor),
      destinationAccountId: this.canonicalizeIdentifier(
        dto.destinationAccountId,
        'destinationAccountId',
      ),
    });
  }

  private async submit(
    principal: AccountingCorrectionPrincipal,
    context: TenantTransactionContext,
    targetOperationIdValue: string,
    domain: AccountingCorrectionDomain,
    dto: ReverseAccountingEventDto,
    replacement: AccountingCorrectionReplacement | undefined,
  ): Promise<AccountingCorrectionMutationResponse> {
    this.assertAuthorized(principal, context);
    const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
    const targetOperationId = this.canonicalizeIdentifier(
      targetOperationIdValue,
      'targetOperationId',
    );
    const occurredAt = this.parseOccurredAt(dto.occurredAt);
    const postingDate = this.operationalTime.resolve(occurredAt).businessDate;
    const kind = replacement ? 'replacement' : 'reversal';
    const semanticReplacement = replacement
      ? {
          amountMinor: replacement.amountMinor.toString(),
          ...(replacement.moneyAccountId ? { moneyAccountId: replacement.moneyAccountId } : {}),
          ...(replacement.destinationAccountId
            ? { destinationAccountId: replacement.destinationAccountId }
            : {}),
        }
      : null;
    const input: AccountingCorrectionCommandInput = {
      operationId,
      targetOperationId,
      domain,
      kind,
      occurredAt,
      postingDate,
      requestHash: this.hashRequest({
        v: ACCOUNTING_CORRECTION_REQUEST_VERSION,
        action: `accounting_correction.${kind}.${domain}`,
        targetOperationId,
        occurredAt: occurredAt.toISOString(),
        replacement: semanticReplacement,
      }),
      ...(replacement ? { replacement } : {}),
    };
    return this.unwrap(await this.repository.correct(context, input));
  }

  private assertAuthorized(
    principal: AccountingCorrectionPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'ACCOUNTING_CORRECTION_WRITE_NOT_ALLOWED',
        message: 'Accounting corrections are not allowed.',
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

  private parseOpeningReplacementAmount(value: string): bigint {
    const amount = this.parseAmount(value);
    if (amount === 0n) {
      throw this.validationException('amountMinor', 'nonZeroDecimalString');
    }
    if (amount < MIN_MONEY_MINOR || amount > MAX_MONEY_MINOR) {
      throw this.validationException('amountMinor', 'maxPostgreSqlBigintMagnitude');
    }
    return amount;
  }

  private parsePositiveAmount(value: string): bigint {
    const amount = this.parseAmount(value);
    if (amount <= 0n) {
      throw this.validationException('amountMinor', 'positiveDecimalString');
    }
    if (amount > MAX_MONEY_MINOR) {
      throw this.validationException('amountMinor', 'maxPostgreSqlBigint');
    }
    return amount;
  }

  private parseAmount(value: string): bigint {
    try {
      return parseMoneyMinorString(value, 'amountMinor');
    } catch (error) {
      if (error instanceof MoneyAmountError) {
        throw this.validationException('amountMinor', 'integerDecimalString');
      }
      throw error;
    }
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

  private unwrap(result: AccountingCorrectionMutationResult): AccountingCorrectionMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: AccountingCorrectionFailure): never {
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
