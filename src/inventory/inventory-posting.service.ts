import { BadRequestException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import {
  InvalidAccountingPostingDateError,
  parseAccountingPostingDate,
} from '../accounting-periods/accounting-posting-date';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { InventoryReadPrincipal } from './inventory-read.types';
import {
  parseInventoryPostingCommand,
  type InventoryCommandKind,
} from './inventory-posting-command';
import { InventoryPostingRepository } from './inventory-posting.repository';

@Injectable()
export class InventoryPostingService {
  constructor(
    private readonly repository: InventoryPostingRepository,
    private readonly time: OperationalTimeService,
  ) {}

  async post(
    principal: InventoryReadPrincipal,
    context: TenantTransactionContext,
    kind: InventoryCommandKind,
    body: unknown,
  ) {
    // PRD MVP shop operations are owner-authorized. No feature permission expansion.
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    )
      throw new ForbiddenException({
        code: 'INVENTORY_WRITE_NOT_ALLOWED',
        message: 'Inventory writes are not allowed.',
      });
    const command = parseInventoryPostingCommand(kind, body);
    const postingDate = this.time.resolve(command.occurredAt).businessDate;
    try {
      parseAccountingPostingDate(postingDate);
    } catch (error) {
      if (error instanceof InvalidAccountingPostingDateError)
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
        });
      throw error;
    }
    const result = await this.repository.post(context, command, postingDate);
    if (!result.ok)
      throw new HttpException({ code: result.code, message: result.message }, result.statusCode);
    return result.response;
  }
}
