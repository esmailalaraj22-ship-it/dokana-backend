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
import type { OpeningBalanceDto } from './dto/opening-balance.dto';
import type { OwnerMoneyCommandDto } from './dto/owner-money-command.dto';
import { OwnerLedgerPostingRepository } from './owner-ledger-posting.repository';
import type {
  OpeningBalanceCommandInput,
  OwnerLedgerCommandInput,
  OwnerLedgerCommandKind,
  OwnerLedgerMutationFailure,
  OwnerLedgerMutationResponse,
  OwnerLedgerMutationResult,
} from './owner-ledger.types';

const absoluteIsoInstantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const OWNER_ACTIONS: Record<OwnerLedgerCommandKind, string> = {
  owner_contribution: 'owner_ledger.contribution',
  owner_loan: 'owner_ledger.loan',
  owner_reimbursement: 'owner_ledger.reimbursement',
  owner_personal_withdrawal: 'owner_ledger.personal_withdrawal',
  owner_capital_withdrawal: 'owner_ledger.capital_withdrawal',
};

export const OWNER_LEDGER_REQUEST_VERSION = 1;

type OwnerLedgerPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class OwnerLedgerWriteService {
  constructor(
    private readonly repository: OwnerLedgerPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async postOpeningBalance(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OpeningBalanceDto,
  ): Promise<OwnerLedgerMutationResponse> {
    this.assertAuthorized(principal, context);
    const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
    const moneyAccountId = this.canonicalizeIdentifier(dto.moneyAccountId, 'moneyAccountId');
    const amountMinor = this.parseOpeningAmount(dto.amountMinor);
    const occurredAt = this.parseOccurredAt(dto.occurredAt);
    const postingDate = this.operationalTime.resolve(occurredAt).businessDate;
    const input: OpeningBalanceCommandInput = {
      operationId,
      moneyAccountId,
      amountMinor,
      occurredAt,
      postingDate,
      requestHash: this.hashRequest({
        v: OWNER_LEDGER_REQUEST_VERSION,
        action: 'owner_ledger.opening_balance',
        moneyAccountId,
        amountMinor: amountMinor.toString(),
        occurredAt: occurredAt.toISOString(),
      }),
    };
    return this.unwrap(await this.repository.postOpeningBalance(context, input));
  }

  postContribution(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.postOwnerCommand(principal, context, dto, 'owner_contribution');
  }

  postLoan(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.postOwnerCommand(principal, context, dto, 'owner_loan');
  }

  postReimbursement(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.postOwnerCommand(principal, context, dto, 'owner_reimbursement');
  }

  postPersonalWithdrawal(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.postOwnerCommand(principal, context, dto, 'owner_personal_withdrawal');
  }

  postCapitalWithdrawal(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OwnerMoneyCommandDto,
  ): Promise<OwnerLedgerMutationResponse> {
    return this.postOwnerCommand(principal, context, dto, 'owner_capital_withdrawal');
  }

  private async postOwnerCommand(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
    dto: OwnerMoneyCommandDto,
    kind: OwnerLedgerCommandKind,
  ): Promise<OwnerLedgerMutationResponse> {
    this.assertAuthorized(principal, context);
    const operationId = this.canonicalizeIdentifier(dto.operationId, 'operationId');
    const moneyAccountId = this.canonicalizeIdentifier(dto.moneyAccountId, 'moneyAccountId');
    const amountMinor = this.parsePositiveAmount(dto.amountMinor);
    const occurredAt = this.parseOccurredAt(dto.occurredAt);
    const postingDate = this.operationalTime.resolve(occurredAt).businessDate;
    const input: OwnerLedgerCommandInput = {
      operationId,
      moneyAccountId,
      amountMinor,
      occurredAt,
      postingDate,
      requestHash: this.hashRequest({
        v: OWNER_LEDGER_REQUEST_VERSION,
        action: OWNER_ACTIONS[kind],
        moneyAccountId,
        amountMinor: amountMinor.toString(),
        occurredAt: occurredAt.toISOString(),
      }),
    };
    return this.unwrap(await this.repository.postOwnerCommand(context, input, kind));
  }

  private assertAuthorized(
    principal: OwnerLedgerPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'OWNER_LEDGER_WRITE_NOT_ALLOWED',
        message: 'Owner Ledger writes are not allowed.',
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

  private parseOpeningAmount(value: string): bigint {
    const amount = this.parseAmount(value, 'amountMinor');
    if (amount < MIN_MONEY_MINOR || amount > MAX_MONEY_MINOR) {
      throw this.validationException('amountMinor', 'maxPostgreSqlBigintMagnitude');
    }
    return amount;
  }

  private parsePositiveAmount(value: string): bigint {
    const amount = this.parseAmount(value, 'amountMinor');
    if (amount <= 0n) {
      throw this.validationException('amountMinor', 'positiveDecimalString');
    }
    if (amount > MAX_MONEY_MINOR) {
      throw this.validationException('amountMinor', 'maxPostgreSqlBigint');
    }
    return amount;
  }

  private parseAmount(value: string, field: string): bigint {
    try {
      return parseMoneyMinorString(value, field);
    } catch (error) {
      if (error instanceof MoneyAmountError) {
        throw this.validationException(field, 'integerDecimalString');
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

  private unwrap(result: OwnerLedgerMutationResult): OwnerLedgerMutationResponse {
    if (result.ok) {
      return result.response;
    }
    this.throwMutationFailure(result.error);
  }

  private throwMutationFailure(error: OwnerLedgerMutationFailure): never {
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
