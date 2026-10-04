import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AuthenticationModule } from '../auth/auth.module';
import { MoneyAccountsModule } from '../money-accounts/money-accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { PlatformAuthorityService } from './platform-authority.service';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminRepository } from './platform-admin.repository';
import { PlatformAdminService } from './platform-admin.service';
import { StoreProvisioningService } from './store-provisioning.service';
import { SubscriptionLifecycleRepository } from './subscription-lifecycle.repository';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule, MoneyAccountsModule, SettingsModule],
  controllers: [PlatformAdminController],
  providers: [
    PlatformAuthorityService,
    PlatformAdminGuard,
    PlatformAdminRepository,
    PlatformAdminService,
    StoreProvisioningService,
    SubscriptionLifecycleRepository,
    SubscriptionLifecycleService,
  ],
  exports: [PlatformAuthorityService, StoreProvisioningService, SubscriptionLifecycleService],
})
export class PlatformAuthorityModule {}
