import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InventoryController } from './inventory.controller';
import { InventoryReadRepository } from './inventory-read.repository';
import { InventoryReadService } from './inventory-read.service';
import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { SettingsModule } from '../settings/settings.module';
import { InventoryPostingRepository } from './inventory-posting.repository';
import { InventoryPostingService } from './inventory-posting.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule, AccountingPeriodsModule, SettingsModule],
  controllers: [InventoryController],
  providers: [
    InventoryReadRepository,
    InventoryReadService,
    InventoryPostingRepository,
    InventoryPostingService,
  ],
})
export class InventoryModule {}
