import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';

import { AccountingPeriodNotPostingEligibleError } from '../accounting-periods/accounting-period-posting-context.service';
import { AccountingPeriodIntegrityError } from '../accounting-periods/accounting-period-provisioning.service';
import { InvalidAccountingPostingDateError } from '../accounting-periods/accounting-posting-date';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { TenantTransactionContext } from '../database/database.types';
import { moneyMovementTypes } from '../database/schema/ledger';
import { assertMoneyAmountDeltaMinor, MoneyAmountError } from './money-amount';
import { MoneyFactIdentityError } from './money-movement-identity';
import { MoneyMovementPostingRepository } from './money-movement-posting.repository';
import type {
  MoneyMovementEffectInput,
  MoneyMovementPostingCommand,
  MoneyMovementPostingResponse,
} from './money-movement.types';

// Internal, trusted Money Movement Authority. It is deliberately not a public generic
// money-posting endpoint; future domain commands (S10.3-S10.5, later monetary Stations)
// determine legitimate economic intent and invoke this authority with server-controlled data.
@Injectable()
export class MoneyMovementPostingService {
  constructor(
    private readonly repository: MoneyMovementPostingRepository,
    private readonly operationalTime: OperationalTimeService,
  ) {}

  async post(
    context: TenantTransactionContext,
    command: MoneyMovementPostingCommand,
  ): Promise<MoneyMovementPostingResponse> {
    this.validateCommand(command);

    // D10-P3: S10 posting date is the Store-local business date of the event instant.
    const postingDate = this.operationalTime.resolve(command.occurredAt).businessDate;

    try {
      return await this.repository.post(context, command, postingDate);
    } catch (error) {
      if (error instanceof AccountingPeriodNotPostingEligibleError) {
        throw new ConflictException({
          code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
          message: 'Accounting Period is not eligible for posting.',
        });
      }
      if (error instanceof AccountingPeriodIntegrityError) {
        throw new ConflictException({
          code: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
          message: 'Accounting Period identity or boundaries are inconsistent.',
        });
      }
      if (
        error instanceof InvalidAccountingPostingDateError ||
        error instanceof MoneyAmountError ||
        error instanceof MoneyFactIdentityError
      ) {
        throw this.validationException('command', 'invalid');
      }
      throw error;
    }
  }

  private validateCommand(command: MoneyMovementPostingCommand): void {
    if (!isUUID(command.operationId)) {
      throw this.validationException('operationId', 'isUuid');
    }
    if (typeof command.action !== 'string' || command.action.length === 0) {
      throw this.validationException('action', 'nonEmpty');
    }
    if (typeof command.requestHash !== 'string' || command.requestHash.length === 0) {
      throw this.validationException('requestHash', 'nonEmpty');
    }
    if (!(command.occurredAt instanceof Date) || !Number.isFinite(command.occurredAt.getTime())) {
      throw this.validationException('occurredAt', 'isDate');
    }
    if (!Array.isArray(command.effects) || command.effects.length === 0) {
      throw this.validationException('effects', 'nonEmpty');
    }

    const discriminators = new Set<string>();
    for (const effect of command.effects) {
      this.validateEffect(effect);
      if (discriminators.has(effect.discriminator)) {
        throw this.validationException('effects.discriminator', 'unique');
      }
      discriminators.add(effect.discriminator);
    }
  }

  private validateEffect(effect: MoneyMovementEffectInput): void {
    if (typeof effect.discriminator !== 'string' || effect.discriminator.length === 0) {
      throw this.validationException('effects.discriminator', 'nonEmpty');
    }
    if (!isUUID(effect.accountId)) {
      throw this.validationException('effects.accountId', 'isUuid');
    }
    assertMoneyAmountDeltaMinor(effect.amountDeltaMinor, 'effects.amountDeltaMinor');
    if (!(moneyMovementTypes as readonly string[]).includes(effect.movementType)) {
      throw this.validationException('effects.movementType', 'invalid');
    }
    if (typeof effect.referenceType !== 'string' || effect.referenceType.length === 0) {
      throw this.validationException('effects.referenceType', 'nonEmpty');
    }
    if (!isUUID(effect.referenceId)) {
      throw this.validationException('effects.referenceId', 'isUuid');
    }
    for (const [field, value] of [
      ['effects.transferGroupId', effect.transferGroupId],
      ['effects.counterAccountId', effect.counterAccountId],
      ['effects.reversalOfId', effect.reversalOfId],
    ] as const) {
      if (value !== undefined && value !== null && !isUUID(value)) {
        throw this.validationException(field, 'isUuid');
      }
    }
  }

  private validationException(field: string, constraint: string): BadRequestException {
    return new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: [{ field, constraints: [constraint] }],
    });
  }
}
