import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { OfflineEntitlementHandoffService } from './offline-entitlement-handoff.service';
import { OfflineLicenseAdminService } from './offline-license-admin.service';
import { OfflineLicenseController } from './offline-license.controller';
import { OfflineLicenseCryptoService } from './offline-license-crypto';
import { OfflineLicenseRepository } from './offline-license.repository';
import { OfflineLicenseService } from './offline-license.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule],
  controllers: [OfflineLicenseController],
  providers: [
    OfflineLicenseCryptoService,
    OfflineLicenseRepository,
    OfflineLicenseService,
    OfflineLicenseAdminService,
    OfflineEntitlementHandoffService,
  ],
  exports: [
    OfflineLicenseCryptoService,
    OfflineLicenseRepository,
    OfflineLicenseService,
    OfflineLicenseAdminService,
    OfflineEntitlementHandoffService,
  ],
})
export class OfflineLicensesModule {}
