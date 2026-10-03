import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MoneyAccountsModule } from '../money-accounts/money-accounts.module';
import { SettingsModule } from '../settings/settings.module';
import { PlatformAuthorityService } from './platform-authority.service';
import { StoreProvisioningService } from './store-provisioning.service';
import { SubscriptionLifecycleRepository } from './subscription-lifecycle.repository';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

@Module({
  imports: [DatabaseModule, MoneyAccountsModule, SettingsModule],
  providers: [
    PlatformAuthorityService,
    StoreProvisioningService,
    SubscriptionLifecycleRepository,
    SubscriptionLifecycleService,
  ],
  exports: [PlatformAuthorityService, StoreProvisioningService, SubscriptionLifecycleService],
})
export class PlatformAuthorityModule {}
