import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { appSettings } from '../database/schema';
import type { TenantTransactionContext } from '../database/database.types';
import type { AppSettingsReadRow } from './app-settings.types';

@Injectable()
export class AppSettingsReadRepository {
  constructor(private readonly database: DatabaseService) {}

  findForCurrentStore(context: TenantTransactionContext): Promise<AppSettingsReadRow | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const rows = await transaction
        .select({
          dailyReportTimeMinutes: appSettings.dailyReportTimeMinutes,
          defaultCreditPolicy: appSettings.defaultCreditPolicy,
          defaultCreditLimitMinor: appSettings.defaultCreditLimitMinor,
          allowNegativeStock: appSettings.allowNegativeStock,
          lowStockAlertEnabled: appSettings.lowStockAlertEnabled,
          debtAgeAlertDays: appSettings.debtAgeAlertDays,
          backupEnabled: appSettings.backupEnabled,
          backupIntervalHours: appSettings.backupIntervalHours,
          timezoneName: appSettings.timezoneName,
          version: appSettings.version,
          createdAt: appSettings.createdAt,
          updatedAt: appSettings.updatedAt,
        })
        .from(appSettings)
        .where(eq(appSettings.storeId, context.storeId))
        .limit(1);

      return rows[0];
    });
  }
}
