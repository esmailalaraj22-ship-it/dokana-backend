import { BadRequestException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';

import {
  InvalidAccountingPostingDateError,
  parseAccountingPostingDate,
} from '../accounting-periods/accounting-posting-date';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { InventoryReadPrincipal } from './inventory-read.types';
import { parseStockCountCommand } from './stock-count-command';
import { StockCountRepository } from './stock-count.repository';

@Injectable()
export class StockCountService {
  constructor(
    private readonly repository: StockCountRepository,
    private readonly time: OperationalTimeService,
  ) {}

  async post(principal: InventoryReadPrincipal, context: TenantTransactionContext, body: unknown) {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'INVENTORY_WRITE_NOT_ALLOWED',
        message: 'Inventory writes are not allowed.',
      });
    }
    const command = parseStockCountCommand(body);
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
    const result = await this.repository.post(context, command, postingDate);
    if (!result.ok) {
      throw new HttpException({ code: result.code, message: result.message }, result.statusCode);
    }
    return result.response;
  }
}
