import { BadRequestException, Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { AppSettingsReadService } from '../settings/app-settings-read.service';
import { AppSettingsWriteService } from '../settings/app-settings-write.service';
import type { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';
import type {
  NotificationSettingsMutationResponse,
  NotificationSettingsResponse,
} from './notification.types';

type SettingsPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly reads: AppSettingsReadService,
    private readonly writes: AppSettingsWriteService,
  ) {}

  async get(
    principal: SettingsPrincipal,
    context: TenantTransactionContext,
  ): Promise<NotificationSettingsResponse> {
    const settings = await this.reads.get(principal, context);
    return this.map(settings);
  }

  async update(
    principal: SettingsPrincipal,
    context: TenantTransactionContext,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsMutationResponse> {
    if (
      dto.customerDebtAmountAlertMinor === undefined &&
      dto.debtAgeAlertDays === undefined &&
      dto.lowStockAlertEnabled === undefined
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: [{ field: 'body', constraints: ['notificationSettingsMutableField'] }],
      });
    }
    const settings = await this.writes.update(principal, context, {
      operationId: dto.operationId,
      expectedVersion: dto.expectedVersion,
      customerDebtAmountAlertMinor: dto.customerDebtAmountAlertMinor,
      debtAgeAlertDays: dto.debtAgeAlertDays,
      lowStockAlertEnabled: dto.lowStockAlertEnabled,
    });
    return { ...this.map(settings), operationId: settings.operationId };
  }

  private map(settings: {
    customerDebtAmountAlertMinor: string;
    debtAgeAlertDays: number;
    lowStockAlertEnabled: boolean;
    version: string;
    updatedAt: string;
  }): NotificationSettingsResponse {
    return {
      customerDebtAmountAlertMinor: settings.customerDebtAmountAlertMinor,
      debtAgeAlertDays: settings.debtAgeAlertDays,
      lowStockAlertEnabled: settings.lowStockAlertEnabled,
      version: settings.version,
      updatedAt: settings.updatedAt,
    };
  }
}
