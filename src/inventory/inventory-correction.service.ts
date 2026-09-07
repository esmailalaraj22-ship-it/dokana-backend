import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  InvalidAccountingPostingDateError,
  parseAccountingPostingDate,
} from '../accounting-periods/accounting-posting-date';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import { parseInventoryCorrectionCommand } from './inventory-correction-command';
import { InventoryCorrectionRepository } from './inventory-correction.repository';
import type {
  InventoryCorrectionFailure,
  InventoryCorrectionResult,
} from './inventory-correction-response';
import type { InventoryReadPrincipal } from './inventory-read.types';

@Injectable()
export class InventoryCorrectionService {
  constructor(
    private readonly repository: InventoryCorrectionRepository,
    private readonly time: OperationalTimeService,
  ) {}

  async correct(
    principal: InventoryReadPrincipal,
    context: TenantTransactionContext,
    body: unknown,
  ) {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'INVENTORY_CORRECTION_WRITE_NOT_ALLOWED',
        message: 'Inventory corrections are not allowed.',
      });
    }
    const command = parseInventoryCorrectionCommand(body);
    const postingDate = this.time.resolve(command.occurredAt).businessDate;
    try {
      parseAccountingPostingDate(postingDate);
    } catch (error) {
      if (error instanceof InvalidAccountingPostingDateError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
        });
      }
      throw error;
    }
    return this.unwrap(await this.repository.correct(context, command, postingDate));
  }

  private unwrap(result: InventoryCorrectionResult) {
    if (result.ok) return result.response;
    this.throwFailure(result.error);
  }

  private throwFailure(error: InventoryCorrectionFailure): never {
    const body = { code: error.code, message: error.message };
    if (error.statusCode === 400) throw new BadRequestException(body);
    if (error.statusCode === 404) throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}
