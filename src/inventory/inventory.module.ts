import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InventoryController } from './inventory.controller';
import { InventoryReadRepository } from './inventory-read.repository';
import { InventoryReadService } from './inventory-read.service';
import { AccountingPeriodsModule } from '../accounting-periods/accounting-periods.module';
import { SettingsModule } from '../settings/settings.module';
import { InventoryCorrectionRepository } from './inventory-correction.repository';
import { InventoryCorrectionService } from './inventory-correction.service';
import { InventoryPostingRepository } from './inventory-posting.repository';
import { InventoryPostingService } from './inventory-posting.service';
import { StockCountRepository } from './stock-count.repository';
import { StockCountService } from './stock-count.service';

@Module({
  imports: [AuthenticationModule, DatabaseModule, AccountingPeriodsModule, SettingsModule],
  controllers: [InventoryController],
  providers: [
    InventoryReadRepository,
    InventoryReadService,
    InventoryCorrectionRepository,
    InventoryCorrectionService,
    InventoryPostingRepository,
    InventoryPostingService,
    StockCountRepository,
    StockCountService,
  ],
})
export class InventoryModule {}
