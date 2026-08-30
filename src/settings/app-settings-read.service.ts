import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { AppSettingsReadRepository } from './app-settings-read.repository';
import {
  MVP_TIMEZONE_NAME,
  type AppSettingsReadModel,
  type AppSettingsReadRow,
} from './app-settings.types';

type AppSettingsReadPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class AppSettingsReadService {
  constructor(private readonly repository: AppSettingsReadRepository) {}

  async get(
    principal: AppSettingsReadPrincipal,
    context: TenantTransactionContext,
  ): Promise<AppSettingsReadModel> {
    this.assertAuthorized(principal, context);
    const row = await this.repository.findForCurrentStore(context);

    if (!row) {
      throw new NotFoundException({
        code: 'SETTINGS_NOT_INITIALIZED',
        message: 'Store settings are not initialized.',
      });
    }

    return this.mapReadModel(row);
  }

  private assertAuthorized(
    principal: AppSettingsReadPrincipal,
    context: TenantTransactionContext,
  ): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'SETTINGS_READ_NOT_ALLOWED',
        message: 'Settings reads are not allowed.',
      });
    }
  }

  private mapReadModel(row: AppSettingsReadRow): AppSettingsReadModel {
    if (row.timezoneName !== MVP_TIMEZONE_NAME) {
      throw new ServiceUnavailableException({
        code: 'SETTINGS_TIMEZONE_UNSUPPORTED',
        message: 'Store settings are unavailable.',
      });
    }

    return {
      dailyReportTimeMinutes: row.dailyReportTimeMinutes,
      defaultCreditPolicy: row.defaultCreditPolicy,
      defaultCreditLimitMinor: row.defaultCreditLimitMinor?.toString() ?? null,
      allowNegativeStock: row.allowNegativeStock,
      lowStockAlertEnabled: row.lowStockAlertEnabled,
      debtAgeAlertDays: row.debtAgeAlertDays,
      backupEnabled: row.backupEnabled,
      backupIntervalHours: row.backupIntervalHours,
      timezoneName: MVP_TIMEZONE_NAME,
      version: row.version.toString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
